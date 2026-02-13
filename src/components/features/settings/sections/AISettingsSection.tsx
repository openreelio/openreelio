/**
 * AISettingsSection Component
 *
 * Comprehensive AI settings section for the settings dialog.
 * Includes provider configuration, model selection, generation parameters,
 * cost controls, and behavior settings.
 *
 * Security Features:
 * - API keys are stored in encrypted vault (not localStorage)
 * - Keys are never displayed in full after entry
 * - Secure IPC communication for credential operations
 */

import React, { useCallback, useState, useEffect } from 'react';
import type { AISettings, ProviderType, ProposalReviewMode } from '@/stores/settingsStore';
import { CostControlPanel } from './CostControlPanel';
import { useAIModels, getDefaultModel } from '@/hooks/useAIModels';
import { useCredentials, type CredentialProvider } from '@/hooks/useCredentials';
import { isVideoGenerationEnabled } from '@/config/featureFlags';

// =============================================================================
// Types
// =============================================================================

export interface AISettingsSectionProps {
  /** Current AI settings */
  settings: AISettings;
  /** Callback when settings are updated */
  onUpdate: (values: Partial<AISettings>) => void;
  /** Whether inputs should be disabled */
  disabled?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const PROVIDER_OPTIONS: Array<{ value: ProviderType; label: string; description: string }> = [
  { value: 'openai', label: 'OpenAI', description: 'GPT-5, O3 models for advanced reasoning' },
  {
    value: 'anthropic',
    label: 'Anthropic',
    description: 'Claude 4.x models for coding and analysis',
  },
  { value: 'gemini', label: 'Google Gemini', description: 'Gemini 3 with 2M context window' },
  { value: 'local', label: 'Local (Ollama)', description: 'Run models locally with Ollama' },
];

const REVIEW_MODE_OPTIONS: Array<{
  value: ProposalReviewMode;
  label: string;
  description: string;
}> = [
  {
    value: 'always',
    label: 'Always Review',
    description: 'Always ask for confirmation before applying',
  },
  { value: 'smart', label: 'Smart Review', description: 'Only review high-impact changes' },
  { value: 'auto_apply', label: 'Auto Apply', description: 'Apply changes without confirmation' },
];

// =============================================================================
// Sub-Components
// =============================================================================

interface SectionHeaderProps {
  title: string;
  description?: string;
}

const SectionHeader: React.FC<SectionHeaderProps> = ({ title, description }) => (
  <div className="border-b border-editor-border pb-2 mb-4">
    <h3 className="text-sm font-medium text-editor-text">{title}</h3>
    {description && <p className="text-xs text-editor-text-muted mt-1">{description}</p>}
  </div>
);

interface ToggleFieldProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  description?: string;
}

const ToggleField: React.FC<ToggleFieldProps> = ({
  id,
  label,
  checked,
  onChange,
  disabled,
  description,
}) => (
  <div className="flex items-start justify-between py-2">
    <div className="flex-1">
      <label htmlFor={id} className="text-sm text-editor-text cursor-pointer">
        {label}
      </label>
      {description && <p className="text-xs text-editor-text-muted mt-0.5">{description}</p>}
    </div>
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      className="mt-1 h-4 w-4 rounded border-editor-border bg-editor-bg text-primary-500 focus:ring-primary-500 focus:ring-offset-0 disabled:opacity-50"
    />
  </div>
);

interface StatusBadgeProps {
  isConfigured: boolean;
  isLoading?: boolean;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ isConfigured, isLoading }) => {
  if (isLoading) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-600 text-gray-200">
        Checking...
      </span>
    );
  }

  return isConfigured ? (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-600 text-green-100">
      Configured
    </span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-600 text-yellow-100">
      Not configured
    </span>
  );
};

// =============================================================================
// Model Selector Component
// =============================================================================

interface ModelSelectorProps {
  id?: string;
  provider: ProviderType;
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
  id,
  provider,
  value,
  onChange,
  disabled,
}) => {
  const { models, isLoading, error } = useAIModels(provider);

  // Handle provider change - update to default model if current is not available
  useEffect(() => {
    if (!isLoading && models.length > 0 && !models.includes(value)) {
      const defaultModel = getDefaultModel(provider);
      if (models.includes(defaultModel)) {
        onChange(defaultModel);
      } else if (models[0]) {
        onChange(models[0]);
      }
    }
  }, [provider, models, value, onChange, isLoading]);

  if (isLoading) {
    return (
      <div className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text-muted">
        Loading models...
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text focus:outline-none focus:border-primary-500 disabled:opacity-50"
        >
          <option value={value}>{value}</option>
        </select>
        <p className="text-xs text-red-400">Failed to load models: {error}</p>
      </div>
    );
  }

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || models.length === 0}
      className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text focus:outline-none focus:border-primary-500 disabled:opacity-50"
    >
      {models.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
    </select>
  );
};

// =============================================================================
// API Key Input Component
// =============================================================================

interface SecureApiKeyInputProps {
  provider: CredentialProvider;
  placeholder: string;
  disabled?: boolean;
  onSaved?: () => void;
}

const SecureApiKeyInput: React.FC<SecureApiKeyInputProps> = ({
  provider,
  placeholder,
  disabled,
  onSaved,
}) => {
  const { status, storeCredential, deleteCredential, isSaving, isLoading } = useCredentials();
  const [inputValue, setInputValue] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isConfigured = status[provider];

  const handleSave = async () => {
    if (!inputValue.trim()) return;

    try {
      setSaveError(null);
      await storeCredential(provider, inputValue);
      setInputValue('');
      setShowInput(false);
      onSaved?.();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const handleDelete = async () => {
    try {
      setSaveError(null);
      await deleteCredential(provider);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      setShowInput(false);
      setInputValue('');
    }
  };

  if (isLoading) {
    return (
      <div className="px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text-muted">
        Checking credentials...
      </div>
    );
  }

  if (isConfigured && !showInput) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex-1 px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text">
            ••••••••••••••••
          </div>
          <button
            type="button"
            onClick={() => setShowInput(true)}
            disabled={disabled}
            className="px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text hover:bg-editor-bg-hover disabled:opacity-50"
          >
            Change
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={disabled || isSaving}
            className="px-3 py-2 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          >
            {isSaving ? 'Deleting...' : 'Delete'}
          </button>
        </div>
        <p className="text-xs text-green-400">API key is securely stored in encrypted vault</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || isSaving}
          className="flex-1 px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text placeholder-editor-text-muted focus:outline-none focus:border-primary-500 disabled:opacity-50"
          autoComplete="new-password"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={disabled || isSaving || !inputValue.trim()}
          className="px-3 py-2 rounded bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50"
        >
          {isSaving ? 'Saving...' : 'Save'}
        </button>
        {isConfigured && (
          <button
            type="button"
            onClick={() => {
              setShowInput(false);
              setInputValue('');
            }}
            disabled={disabled}
            className="px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text hover:bg-editor-bg-hover disabled:opacity-50"
          >
            Cancel
          </button>
        )}
      </div>
      {saveError && <p className="text-xs text-red-400">{saveError}</p>}
      <p className="text-xs text-editor-text-muted">
        Your API key will be encrypted and stored securely. It never leaves your device.
      </p>
    </div>
  );
};

// =============================================================================
// Main Component
// =============================================================================

export const AISettingsSection: React.FC<AISettingsSectionProps> = ({
  settings,
  onUpdate,
  disabled = false,
}) => {
  const { status: credentialStatus, isLoading: credentialsLoading } = useCredentials();
  const videoGenerationEnabled = isVideoGenerationEnabled();

  // Handlers
  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newProvider = e.target.value as ProviderType;
      const defaultModel = getDefaultModel(newProvider);
      onUpdate({
        primaryProvider: newProvider,
        primaryModel: defaultModel,
      });
    },
    [onUpdate],
  );

  const handleModelChange = useCallback(
    (model: string) => {
      onUpdate({ primaryModel: model });
    },
    [onUpdate],
  );

  const handleTemperatureChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUpdate({ temperature: parseFloat(e.target.value) });
    },
    [onUpdate],
  );

  const handleMaxTokensChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseInt(e.target.value, 10);
      if (!isNaN(value) && value > 0) {
        onUpdate({ maxTokens: value });
      }
    },
    [onUpdate],
  );

  const handleReviewModeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onUpdate({ proposalReviewMode: e.target.value as ProposalReviewMode });
    },
    [onUpdate],
  );

  const handleOllamaUrlChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUpdate({ ollamaUrl: e.target.value || null });
    },
    [onUpdate],
  );

  // Get credential provider from settings provider
  const getCredentialProvider = (provider: ProviderType): CredentialProvider | null => {
    switch (provider) {
      case 'openai':
        return 'openai';
      case 'anthropic':
        return 'anthropic';
      case 'gemini':
        return 'google';
      default:
        return null;
    }
  };

  // Render API key field based on provider
  const renderApiKeyField = () => {
    const credentialProvider = getCredentialProvider(settings.primaryProvider);

    if (settings.primaryProvider === 'local') {
      return (
        <div>
          <label
            htmlFor="ollama-url"
            className="block text-sm font-medium text-editor-text-muted mb-1"
          >
            Ollama URL
          </label>
          <input
            id="ollama-url"
            type="text"
            value={settings.ollamaUrl || ''}
            onChange={handleOllamaUrlChange}
            placeholder="http://localhost:11434"
            disabled={disabled}
            className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text placeholder-editor-text-muted focus:outline-none focus:border-primary-500 disabled:opacity-50"
          />
          <p className="mt-1 text-xs text-editor-text-muted">
            URL of your Ollama server. Ensure Ollama is running.
          </p>
        </div>
      );
    }

    if (!credentialProvider) return null;

    const providerLabels: Partial<Record<CredentialProvider, { label: string; placeholder: string }>> = {
      openai: { label: 'OpenAI API Key', placeholder: 'sk-...' },
      anthropic: { label: 'Anthropic API Key', placeholder: 'sk-ant-...' },
      google: { label: 'Google API Key', placeholder: 'AIza...' },
    };

    const labelInfo = providerLabels[credentialProvider];
    if (!labelInfo) return null;

    const { label, placeholder } = labelInfo;

    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-sm font-medium text-editor-text-muted">{label}</label>
          <StatusBadge
            isConfigured={credentialStatus[credentialProvider]}
            isLoading={credentialsLoading}
          />
        </div>
        <SecureApiKeyInput
          provider={credentialProvider}
          placeholder={placeholder}
          disabled={disabled}
        />
      </div>
    );
  };

  return (
    <div className="space-y-8">
      {/* Provider Configuration */}
      <section>
        <SectionHeader
          title="Provider Configuration"
          description="Configure your AI provider and API credentials"
        />
        <div className="space-y-4">
          {/* Provider Selection */}
          <div>
            <label
              htmlFor="primary-provider"
              className="block text-sm font-medium text-editor-text-muted mb-1"
            >
              Primary Provider
            </label>
            <select
              id="primary-provider"
              value={settings.primaryProvider}
              onChange={handleProviderChange}
              disabled={disabled}
              className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text focus:outline-none focus:border-primary-500 disabled:opacity-50"
            >
              {PROVIDER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-editor-text-muted">
              {PROVIDER_OPTIONS.find((o) => o.value === settings.primaryProvider)?.description}
            </p>
          </div>

          {/* API Key / URL Field */}
          {renderApiKeyField()}

          {/* Model Selection */}
          <div>
            <label
              htmlFor="primary-model"
              className="block text-sm font-medium text-editor-text-muted mb-1"
            >
              Model
            </label>
            <ModelSelector
              id="primary-model"
              provider={settings.primaryProvider}
              value={settings.primaryModel}
              onChange={handleModelChange}
              disabled={disabled}
            />
            <p className="mt-1 text-xs text-editor-text-muted">
              Select the AI model to use for editing operations
            </p>
          </div>
        </div>
      </section>

      {/* Generation Parameters */}
      <section>
        <SectionHeader
          title="Generation Parameters"
          description="Fine-tune AI response generation"
        />
        <div className="space-y-4">
          {/* Temperature */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="temperature" className="text-sm font-medium text-editor-text-muted">
                Temperature
              </label>
              <span className="text-sm text-editor-text">{settings.temperature.toFixed(1)}</span>
            </div>
            <input
              id="temperature"
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={settings.temperature}
              onChange={handleTemperatureChange}
              disabled={disabled}
              className="w-full h-2 bg-editor-border rounded-lg appearance-none cursor-pointer disabled:opacity-50"
            />
            <div className="flex justify-between text-xs text-editor-text-muted mt-1">
              <span>Precise</span>
              <span>Creative</span>
            </div>
          </div>

          {/* Max Tokens */}
          <div>
            <label
              htmlFor="max-tokens"
              className="block text-sm font-medium text-editor-text-muted mb-1"
            >
              Max Tokens
            </label>
            <input
              id="max-tokens"
              type="number"
              min="256"
              max="128000"
              value={settings.maxTokens}
              onChange={handleMaxTokensChange}
              disabled={disabled}
              className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text focus:outline-none focus:border-primary-500 disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-editor-text-muted">
              Maximum number of tokens in the response (256-128,000)
            </p>
          </div>
        </div>
      </section>

      {/* Cost Controls */}
      <section>
        <CostControlPanel settings={settings} onUpdate={onUpdate} disabled={disabled} />
      </section>

      {/* Behavior Settings */}
      <section>
        <SectionHeader
          title="Behavior"
          description="Configure how AI interacts with your workflow"
        />
        <div className="space-y-4">
          {/* Proposal Review Mode */}
          <div>
            <label
              htmlFor="proposal-review-mode"
              className="block text-sm font-medium text-editor-text-muted mb-1"
            >
              Proposal Review Mode
            </label>
            <select
              id="proposal-review-mode"
              value={settings.proposalReviewMode}
              onChange={handleReviewModeChange}
              disabled={disabled}
              className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text focus:outline-none focus:border-primary-500 disabled:opacity-50"
            >
              {REVIEW_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-editor-text-muted">
              {
                REVIEW_MODE_OPTIONS.find((o) => o.value === settings.proposalReviewMode)
                  ?.description
              }
            </p>
          </div>

          {/* Toggle Fields */}
          <div className="space-y-1">
            <ToggleField
              id="auto-analyze"
              label="Auto-analyze on Import"
              checked={settings.autoAnalyzeOnImport}
              onChange={(checked) => onUpdate({ autoAnalyzeOnImport: checked })}
              disabled={disabled}
              description="Automatically analyze media when imported"
            />

            <ToggleField
              id="auto-caption"
              label="Auto-caption on Import"
              checked={settings.autoCaptionOnImport}
              onChange={(checked) => onUpdate({ autoCaptionOnImport: checked })}
              disabled={disabled}
              description="Automatically generate captions for video/audio"
            />

            <ToggleField
              id="local-only"
              label="Local Only Mode"
              checked={settings.localOnlyMode}
              onChange={(checked) => onUpdate({ localOnlyMode: checked })}
              disabled={disabled}
              description="Only use local models, no cloud API calls"
            />
          </div>
        </div>
      </section>

      {videoGenerationEnabled && (
        <section>
          <SectionHeader
            title="Video Generation"
            description="Configure AI video generation (Seedance 2.0)"
          />
          <div className="space-y-4">
            {/* Seedance API Key */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-editor-text-muted">
                  Seedance API Key
                </label>
                <StatusBadge
                  isConfigured={credentialStatus.seedance}
                  isLoading={credentialsLoading}
                />
              </div>
              <SecureApiKeyInput
                provider="seedance"
                placeholder="Enter your Seedance API key"
                disabled={disabled}
              />
            </div>

            {/* Default Quality */}
            <div>
              <label
                htmlFor="videogen-quality"
                className="block text-sm font-medium text-editor-text-muted mb-1"
              >
                Default Quality
              </label>
              <select
                id="videogen-quality"
                value={settings.videoGenDefaultQuality}
                onChange={(e) =>
                  onUpdate({
                    videoGenDefaultQuality: e.target.value as 'basic' | 'pro' | 'cinema',
                  })
                }
                disabled={disabled}
                className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text focus:outline-none focus:border-primary-500 disabled:opacity-50"
              >
                <option value="basic">Basic (~$0.10/min)</option>
                <option value="pro">Pro (~$0.30/min)</option>
                <option value="cinema">Cinema (~$0.80/min)</option>
              </select>
              <p className="mt-1 text-xs text-editor-text-muted">
                Default quality tier for video generation requests
              </p>
            </div>

            {/* Per-request cost limit */}
            <div>
              <label
                htmlFor="videogen-limit"
                className="block text-sm font-medium text-editor-text-muted mb-1"
              >
                Per-Request Cost Limit
              </label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-editor-text-muted">$</span>
                <input
                  id="videogen-limit"
                  type="number"
                  min={0}
                  step={0.5}
                  value={(settings.videoGenPerRequestLimitCents / 100).toFixed(2)}
                  onChange={(e) => {
                    const cents = Math.round(parseFloat(e.target.value) * 100);
                    if (!isNaN(cents) && cents >= 0) {
                      onUpdate({ videoGenPerRequestLimitCents: cents });
                    }
                  }}
                  disabled={disabled}
                  className="flex-1 px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text focus:outline-none focus:border-primary-500 disabled:opacity-50"
                />
              </div>
              <p className="mt-1 text-xs text-editor-text-muted">
                Maximum cost per generation request. Set to 0 for unlimited.
              </p>
            </div>
          </div>
        </section>
      )}
    </div>
  );
};

export default AISettingsSection;
