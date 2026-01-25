/**
 * AISettingsPanel Component
 *
 * Configuration panel for AI provider settings.
 * Allows users to configure API keys, select providers, and test connections.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useAISettings } from '@/hooks/useAISettings';
import type { ProviderType } from '@/stores/aiStore';
import { createLogger } from '@/services/logger';

const logger = createLogger('AISettingsPanel');

// =============================================================================
// Types
// =============================================================================

export interface AISettingsPanelProps {
  /** Optional callback when settings are saved successfully */
  onSaved?: () => void;
  /** Optional callback when error occurs */
  onError?: (error: string) => void;
}

// =============================================================================
// Constants
// =============================================================================

const PROVIDER_OPTIONS: Array<{ value: ProviderType; label: string; description: string }> = [
  {
    value: 'openai',
    label: 'OpenAI',
    description: 'GPT-5.2, GPT-4.1, o3 models',
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    description: 'Claude Opus 4.5, Claude Sonnet 4.5',
  },
  {
    value: 'gemini',
    label: 'Google Gemini',
    description: 'Gemini 3 Pro/Flash (preview), 2.5 Pro/Flash',
  },
  {
    value: 'local',
    label: 'Local (Ollama)',
    description: 'Run models locally with Ollama',
  },
];

// =============================================================================
// Helper Components
// =============================================================================

interface StatusIndicatorProps {
  isConfigured: boolean;
  isAvailable: boolean;
  errorMessage: string | null;
}

const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  isConfigured,
  isAvailable,
  errorMessage,
}) => {
  if (errorMessage) {
    return (
      <div className="flex items-center gap-2 text-red-400">
        <span className="w-2 h-2 rounded-full bg-red-500" />
        <span className="text-sm">Error: {errorMessage}</span>
      </div>
    );
  }

  if (isConfigured && isAvailable) {
    return (
      <div className="flex items-center gap-2 text-green-400">
        <span className="w-2 h-2 rounded-full bg-green-500" />
        <span className="text-sm">Connected</span>
      </div>
    );
  }

  if (isConfigured && !isAvailable) {
    return (
      <div className="flex items-center gap-2 text-yellow-400">
        <span className="w-2 h-2 rounded-full bg-yellow-500" />
        <span className="text-sm">Configured (not tested)</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-neutral-400">
      <span className="w-2 h-2 rounded-full bg-neutral-500" />
      <span className="text-sm">Not configured</span>
    </div>
  );
};

// =============================================================================
// Main Component
// =============================================================================

export const AISettingsPanel: React.FC<AISettingsPanelProps> = ({
  onSaved,
  onError,
}) => {
  const {
    formState,
    providerStatus,
    availableModels,
    isConfiguring,
    isConnecting,
    error,
    testResult,
    setProviderType,
    setApiKey,
    setBaseUrl,
    setModel,
    saveConfiguration,
    testConnection,
    clearProvider,
    clearError,
    isFormValid,
  } = useAISettings();

  const [localError, setLocalError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Clear messages after timeout
  useEffect(() => {
    if (localError) {
      const timer = setTimeout(() => setLocalError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [localError]);

  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

  // Handle provider selection
  const handleProviderChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value as ProviderType | '';
      await setProviderType(value === '' ? null : value);
      setLocalError(null);
      setSuccessMessage(null);
    },
    [setProviderType]
  );

  // Handle save
  const handleSave = useCallback(async () => {
    try {
      setLocalError(null);
      await saveConfiguration();
      setSuccessMessage('Settings saved successfully');
      logger.info('AI settings saved');
      if (onSaved) {
        onSaved();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLocalError(message);
      logger.error('Failed to save AI settings', { error: err });
      if (onError) {
        onError(message);
      }
    }
  }, [saveConfiguration, onSaved, onError]);

  // Handle test connection
  const handleTestConnection = useCallback(async () => {
    try {
      setLocalError(null);
      const result = await testConnection();
      if (result.success) {
        const latencyInfo = result.latencyMs != null ? ` (${result.latencyMs}ms)` : '';
        setSuccessMessage(`Connection successful: ${result.provider} - ${result.model}${latencyInfo}`);
        logger.info('Connection test successful', { result });
      } else {
        setLocalError(result.message);
        logger.warn('Connection test failed', { result });
        if (onError) {
          onError(result.message);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLocalError(message);
      logger.error('Connection test failed', { error: err });
      if (onError) {
        onError(message);
      }
    }
  }, [testConnection, onError]);

  // Handle clear
  const handleClear = useCallback(async () => {
    try {
      await clearProvider();
      setSuccessMessage('Provider cleared');
      setLocalError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLocalError(message);
    }
  }, [clearProvider]);

  const displayError = localError || error;
  const showApiKeyField = formState.providerType && formState.providerType !== 'local';
  const showBaseUrlField = formState.providerType === 'local';

  return (
    <div className="p-4 bg-neutral-900 rounded-lg border border-neutral-700">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">🤖</span>
          <h3 className="text-lg font-semibold text-white">AI Provider Settings</h3>
        </div>
        <StatusIndicator
          isConfigured={providerStatus.isConfigured}
          isAvailable={providerStatus.isAvailable}
          errorMessage={providerStatus.errorMessage}
        />
      </div>

      {/* Messages */}
      {displayError && (
        <div className="mb-4 p-3 rounded bg-red-900/30 border border-red-700 text-sm text-red-400 flex items-center justify-between">
          <span>{displayError}</span>
          <button
            onClick={() => {
              setLocalError(null);
              clearError();
            }}
            className="text-red-400 hover:text-red-300"
          >
            ✕
          </button>
        </div>
      )}

      {successMessage && (
        <div className="mb-4 p-3 rounded bg-green-900/30 border border-green-700 text-sm text-green-400">
          {successMessage}
        </div>
      )}

      {testResult && !successMessage && !displayError && (
        <div className={`mb-4 p-3 rounded text-sm ${
          testResult.success
            ? 'bg-green-900/30 border border-green-700 text-green-400'
            : 'bg-yellow-900/30 border border-yellow-700 text-yellow-400'
        }`}>
          <div className="font-medium mb-1">
            {testResult.success ? 'Connection Test Passed' : 'Connection Test Result'}
          </div>
          <div className="text-xs space-y-0.5">
            <div>Provider: {testResult.provider}</div>
            <div>Model: {testResult.model}</div>
            {testResult.latencyMs != null && <div>Latency: {testResult.latencyMs}ms</div>}
            {testResult.message && <div>Message: {testResult.message}</div>}
            {testResult.errorCode && <div>Error Code: {testResult.errorCode}</div>}
          </div>
        </div>
      )}

      {/* Form */}
      <div className="space-y-4">
        {/* Provider Selection */}
        <div>
          <label
            htmlFor="provider-select"
            className="block text-sm font-medium text-neutral-300 mb-1"
          >
            Provider
          </label>
          <select
            id="provider-select"
            value={formState.providerType ?? ''}
            onChange={handleProviderChange}
            disabled={isConfiguring}
            className="w-full px-3 py-2 rounded bg-neutral-800 border border-neutral-600 text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
          >
            <option value="">Select a provider...</option>
            {PROVIDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} - {option.description}
              </option>
            ))}
          </select>
        </div>

        {/* API Key (for cloud providers) */}
        {showApiKeyField && (
          <div>
            <label
              htmlFor="api-key-input"
              className="block text-sm font-medium text-neutral-300 mb-1"
            >
              API Key
            </label>
            <input
              id="api-key-input"
              type="password"
              value={formState.apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={`Enter your ${formState.providerType === 'openai' ? 'OpenAI' : 'Anthropic'} API key`}
              disabled={isConfiguring}
              className="w-full px-3 py-2 rounded bg-neutral-800 border border-neutral-600 text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-neutral-500">
              Your API key is stored locally and never sent to our servers.
            </p>
          </div>
        )}

        {/* Base URL (for local/Ollama) */}
        {showBaseUrlField && (
          <div>
            <label
              htmlFor="base-url-input"
              className="block text-sm font-medium text-neutral-300 mb-1"
            >
              Ollama URL
            </label>
            <input
              id="base-url-input"
              type="text"
              value={formState.baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:11434"
              disabled={isConfiguring}
              className="w-full px-3 py-2 rounded bg-neutral-800 border border-neutral-600 text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500 disabled:opacity-50"
            />
            <p className="mt-1 text-xs text-neutral-500">
              Make sure Ollama is running on your machine.
            </p>
          </div>
        )}

        {/* Model Selection */}
        {formState.providerType && availableModels.length > 0 && (
          <div>
            <label
              htmlFor="model-select"
              className="block text-sm font-medium text-neutral-300 mb-1"
            >
              Model
            </label>
            <select
              id="model-select"
              value={formState.model}
              onChange={(e) => setModel(e.target.value)}
              disabled={isConfiguring}
              className="w-full px-3 py-2 rounded bg-neutral-800 border border-neutral-600 text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
            >
              {availableModels.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Current Configuration */}
        {providerStatus.isConfigured && (
          <div className="p-3 rounded bg-neutral-800 border border-neutral-700">
            <h4 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-2">
              Current Configuration
            </h4>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-400">Provider:</span>
                <span className="text-white">{providerStatus.providerType}</span>
              </div>
              {providerStatus.currentModel && (
                <div className="flex justify-between">
                  <span className="text-neutral-400">Model:</span>
                  <span className="text-white">{providerStatus.currentModel}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={handleClear}
          disabled={isConfiguring || !providerStatus.isConfigured}
          className="px-3 py-2 text-sm rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Clear Configuration
        </button>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={isConnecting || !providerStatus.isConfigured}
            className="px-4 py-2 text-sm rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {isConnecting ? (
              <>
                <span className="animate-spin">⏳</span>
                Testing...
              </>
            ) : (
              'Test Connection'
            )}
          </button>

          <button
            type="button"
            onClick={handleSave}
            disabled={isConfiguring || !isFormValid()}
            className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {isConfiguring ? (
              <>
                <span className="animate-spin">⏳</span>
                Saving...
              </>
            ) : (
              'Save Settings'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AISettingsPanel;
