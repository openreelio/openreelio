/**
 * AISettingsSection Component
 *
 * Comprehensive AI settings section for the settings dialog.
 * Includes provider configuration, generation parameters, cost controls, and behavior settings.
 */

import React, { useCallback } from 'react';
import type { AISettings, ProviderType, ProposalReviewMode } from '@/stores/settingsStore';
import { CostControlPanel } from './CostControlPanel';

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

const PROVIDER_OPTIONS: Array<{ value: ProviderType; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'local', label: 'Local (Ollama)' },
];

const REVIEW_MODE_OPTIONS: Array<{ value: ProposalReviewMode; label: string; description: string }> = [
  { value: 'always', label: 'Always Review', description: 'Always ask for confirmation before applying' },
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
    {description && (
      <p className="text-xs text-editor-text-muted mt-1">{description}</p>
    )}
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
      {description && (
        <p className="text-xs text-editor-text-muted mt-0.5">{description}</p>
      )}
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

// =============================================================================
// Main Component
// =============================================================================

export const AISettingsSection: React.FC<AISettingsSectionProps> = ({
  settings,
  onUpdate,
  disabled = false,
}) => {
  // Handlers
  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onUpdate({ primaryProvider: e.target.value as ProviderType });
    },
    [onUpdate]
  );

  const handleApiKeyChange = useCallback(
    (field: keyof AISettings, value: string) => {
      onUpdate({ [field]: value || null } as Partial<AISettings>);
    },
    [onUpdate]
  );

  const handleTemperatureChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUpdate({ temperature: parseFloat(e.target.value) });
    },
    [onUpdate]
  );

  const handleMaxTokensChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseInt(e.target.value, 10);
      if (!isNaN(value) && value > 0) {
        onUpdate({ maxTokens: value });
      }
    },
    [onUpdate]
  );

  const handleReviewModeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onUpdate({ proposalReviewMode: e.target.value as ProposalReviewMode });
    },
    [onUpdate]
  );

  // Render API key field based on provider
  const renderApiKeyField = () => {
    switch (settings.primaryProvider) {
      case 'openai':
        return (
          <div>
            <label htmlFor="openai-api-key" className="block text-sm font-medium text-editor-text-muted mb-1">
              OpenAI API Key
            </label>
            <input
              id="openai-api-key"
              type="password"
              value={settings.openaiApiKey || ''}
              onChange={(e) => handleApiKeyChange('openaiApiKey', e.target.value)}
              placeholder="sk-..."
              disabled={disabled}
              className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text placeholder-editor-text-muted focus:outline-none focus:border-primary-500 disabled:opacity-50"
            />
          </div>
        );
      case 'anthropic':
        return (
          <div>
            <label htmlFor="anthropic-api-key" className="block text-sm font-medium text-editor-text-muted mb-1">
              Anthropic API Key
            </label>
            <input
              id="anthropic-api-key"
              type="password"
              value={settings.anthropicApiKey || ''}
              onChange={(e) => handleApiKeyChange('anthropicApiKey', e.target.value)}
              placeholder="sk-ant-..."
              disabled={disabled}
              className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text placeholder-editor-text-muted focus:outline-none focus:border-primary-500 disabled:opacity-50"
            />
          </div>
        );
      case 'gemini':
        return (
          <div>
            <label htmlFor="google-api-key" className="block text-sm font-medium text-editor-text-muted mb-1">
              Google API Key
            </label>
            <input
              id="google-api-key"
              type="password"
              value={settings.googleApiKey || ''}
              onChange={(e) => handleApiKeyChange('googleApiKey', e.target.value)}
              placeholder="AIza..."
              disabled={disabled}
              className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text placeholder-editor-text-muted focus:outline-none focus:border-primary-500 disabled:opacity-50"
            />
          </div>
        );
      case 'local':
        return (
          <div>
            <label htmlFor="ollama-url" className="block text-sm font-medium text-editor-text-muted mb-1">
              Ollama URL
            </label>
            <input
              id="ollama-url"
              type="text"
              value={settings.ollamaUrl || ''}
              onChange={(e) => handleApiKeyChange('ollamaUrl', e.target.value)}
              placeholder="http://localhost:11434"
              disabled={disabled}
              className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text placeholder-editor-text-muted focus:outline-none focus:border-primary-500 disabled:opacity-50"
            />
          </div>
        );
      default:
        return null;
    }
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
            <label htmlFor="primary-provider" className="block text-sm font-medium text-editor-text-muted mb-1">
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
          </div>

          {/* API Key / URL Field */}
          {renderApiKeyField()}

          {/* Model Input */}
          <div>
            <label htmlFor="primary-model" className="block text-sm font-medium text-editor-text-muted mb-1">
              Model
            </label>
            <input
              id="primary-model"
              type="text"
              value={settings.primaryModel}
              onChange={(e) => onUpdate({ primaryModel: e.target.value })}
              placeholder="Enter model name"
              disabled={disabled}
              className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text placeholder-editor-text-muted focus:outline-none focus:border-primary-500 disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-editor-text-muted">
              e.g., gpt-4, claude-sonnet-4-5, gemini-2.5-flash, llama3:latest
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
              <span className="text-sm text-editor-text">{settings.temperature}</span>
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
            <label htmlFor="max-tokens" className="block text-sm font-medium text-editor-text-muted mb-1">
              Max Tokens
            </label>
            <input
              id="max-tokens"
              type="number"
              min="1"
              max="128000"
              value={settings.maxTokens}
              onChange={handleMaxTokensChange}
              disabled={disabled}
              className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-editor-text focus:outline-none focus:border-primary-500 disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-editor-text-muted">
              Maximum number of tokens in the response (1-128,000)
            </p>
          </div>
        </div>
      </section>

      {/* Cost Controls */}
      <section>
        <CostControlPanel
          settings={settings}
          onUpdate={onUpdate}
          disabled={disabled}
        />
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
            <label htmlFor="proposal-review-mode" className="block text-sm font-medium text-editor-text-muted mb-1">
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
              {REVIEW_MODE_OPTIONS.find((o) => o.value === settings.proposalReviewMode)?.description}
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
    </div>
  );
};

export default AISettingsSection;
