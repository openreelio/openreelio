/**
 * useAISettings Hook
 *
 * Manages AI provider settings and configuration.
 */

import { useCallback, useState } from 'react';
import { useAIStore, type ProviderType, type ProviderConfig } from '@/stores/aiStore';

export interface AISettingsState {
  providerType: ProviderType | null;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function useAISettings() {
  const {
    providerStatus,
    isConfiguring,
    isConnecting,
    error,
    configureProvider,
    clearProvider,
    testConnection,
    getAvailableModels,
    refreshProviderStatus,
    clearError,
  } = useAIStore();

  // Local state for the form
  const [formState, setFormState] = useState<AISettingsState>({
    providerType: providerStatus.providerType,
    apiKey: '',
    baseUrl: '',
    model: providerStatus.currentModel ?? '',
  });

  const [availableModels, setAvailableModels] = useState<string[]>(providerStatus.availableModels);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Update provider type and fetch models
  const setProviderType = useCallback(async (providerType: ProviderType | null) => {
    setFormState((prev) => ({
      ...prev,
      providerType,
      apiKey: '',
      baseUrl: providerType === 'local' ? 'http://localhost:11434' : '',
      model: '',
    }));

    if (providerType) {
      const models = await getAvailableModels(providerType);
      setAvailableModels(models);
      if (models.length > 0) {
        setFormState((prev) => ({ ...prev, model: models[0] }));
      }
    } else {
      setAvailableModels([]);
    }
  }, [getAvailableModels]);

  // Update API key
  const setApiKey = useCallback((apiKey: string) => {
    setFormState((prev) => ({ ...prev, apiKey }));
    setTestResult(null);
  }, []);

  // Update base URL
  const setBaseUrl = useCallback((baseUrl: string) => {
    setFormState((prev) => ({ ...prev, baseUrl }));
    setTestResult(null);
  }, []);

  // Update model
  const setModel = useCallback((model: string) => {
    setFormState((prev) => ({ ...prev, model }));
  }, []);

  // Save configuration
  const saveConfiguration = useCallback(async () => {
    if (!formState.providerType) {
      throw new Error('Please select a provider');
    }

    if (formState.providerType !== 'local' && !formState.apiKey) {
      throw new Error('API key is required');
    }

    const config: ProviderConfig = {
      providerType: formState.providerType,
      apiKey: formState.apiKey || undefined,
      baseUrl: formState.baseUrl || undefined,
      model: formState.model || undefined,
    };

    await configureProvider(config);
    setTestResult(null);
  }, [formState, configureProvider]);

  // Test connection
  const handleTestConnection = useCallback(async () => {
    try {
      const result = await testConnection();
      setTestResult(result);
      return result;
    } catch (error) {
      setTestResult(null);
      throw error;
    }
  }, [testConnection]);

  // Clear configuration
  const handleClearProvider = useCallback(async () => {
    await clearProvider();
    setFormState({
      providerType: null,
      apiKey: '',
      baseUrl: '',
      model: '',
    });
    setAvailableModels([]);
    setTestResult(null);
  }, [clearProvider]);

  // Validate form
  const isFormValid = useCallback(() => {
    if (!formState.providerType) return false;
    if (formState.providerType !== 'local' && !formState.apiKey) return false;
    return true;
  }, [formState]);

  return {
    // State
    formState,
    providerStatus,
    availableModels,
    isConfiguring,
    isConnecting,
    error,
    testResult,

    // Actions
    setProviderType,
    setApiKey,
    setBaseUrl,
    setModel,
    saveConfiguration,
    testConnection: handleTestConnection,
    clearProvider: handleClearProvider,
    refreshStatus: refreshProviderStatus,
    clearError,
    isFormValid,
  };
}
