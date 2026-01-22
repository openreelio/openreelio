/**
 * AISettingsPanel Component Tests
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AISettingsPanel } from './AISettingsPanel';
import { useAISettings } from '@/hooks/useAISettings';

// Mock the hook
vi.mock('@/hooks/useAISettings');

// Mock logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('AISettingsPanel', () => {
  const mockSetProviderType = vi.fn();
  const mockSetApiKey = vi.fn();
  const mockSetBaseUrl = vi.fn();
  const mockSetModel = vi.fn();
  const mockSaveConfiguration = vi.fn();
  const mockTestConnection = vi.fn();
  const mockClearProvider = vi.fn();
  const mockClearError = vi.fn();
  const mockIsFormValid = vi.fn();

  const defaultHookReturn = {
    formState: {
      providerType: null,
      apiKey: '',
      baseUrl: '',
      model: '',
    },
    providerStatus: {
      providerType: null,
      isConfigured: false,
      isAvailable: false,
      currentModel: null,
      availableModels: [],
      errorMessage: null,
    },
    availableModels: [],
    isConfiguring: false,
    isConnecting: false,
    error: null,
    testResult: null,
    setProviderType: mockSetProviderType,
    setApiKey: mockSetApiKey,
    setBaseUrl: mockSetBaseUrl,
    setModel: mockSetModel,
    saveConfiguration: mockSaveConfiguration,
    testConnection: mockTestConnection,
    clearProvider: mockClearProvider,
    clearError: mockClearError,
    isFormValid: mockIsFormValid,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFormValid.mockReturnValue(false);
    (useAISettings as Mock).mockReturnValue(defaultHookReturn);
  });

  it('renders the panel with header', () => {
    render(<AISettingsPanel />);

    expect(screen.getByText('AI Provider Settings')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });

  it('renders provider selection dropdown', () => {
    render(<AISettingsPanel />);

    expect(screen.getByLabelText('Provider')).toBeInTheDocument();
    expect(screen.getByText('Select a provider...')).toBeInTheDocument();
  });

  it('shows API key field when OpenAI is selected', () => {
    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      formState: {
        providerType: 'openai',
        apiKey: '',
        baseUrl: '',
        model: '',
      },
      availableModels: ['gpt-4o', 'gpt-4'],
    });

    render(<AISettingsPanel />);

    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Enter your OpenAI API key/)).toBeInTheDocument();
  });

  it('shows base URL field when Local is selected', () => {
    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      formState: {
        providerType: 'local',
        apiKey: '',
        baseUrl: 'http://localhost:11434',
        model: '',
      },
      availableModels: ['llama3', 'codellama'],
    });

    render(<AISettingsPanel />);

    expect(screen.getByLabelText('Ollama URL')).toBeInTheDocument();
    expect(screen.getByDisplayValue('http://localhost:11434')).toBeInTheDocument();
  });

  it('shows model selection when models are available', () => {
    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      formState: {
        providerType: 'openai',
        apiKey: 'sk-test',
        baseUrl: '',
        model: 'gpt-4o',
      },
      availableModels: ['gpt-4o', 'gpt-4', 'o1'],
    });

    render(<AISettingsPanel />);

    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    expect(screen.getByDisplayValue('gpt-4o')).toBeInTheDocument();
  });

  it('calls setProviderType when provider is changed', async () => {
    render(<AISettingsPanel />);

    const select = screen.getByLabelText('Provider');
    fireEvent.change(select, { target: { value: 'openai' } });

    await waitFor(() => {
      expect(mockSetProviderType).toHaveBeenCalledWith('openai');
    });
  });

  it('calls setApiKey when API key is changed', () => {
    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      formState: {
        providerType: 'openai',
        apiKey: '',
        baseUrl: '',
        model: '',
      },
    });

    render(<AISettingsPanel />);

    const input = screen.getByLabelText('API Key');
    fireEvent.change(input, { target: { value: 'sk-newkey' } });

    expect(mockSetApiKey).toHaveBeenCalledWith('sk-newkey');
  });

  it('calls saveConfiguration when save button is clicked', async () => {
    mockIsFormValid.mockReturnValue(true);
    mockSaveConfiguration.mockResolvedValue(undefined);

    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      formState: {
        providerType: 'openai',
        apiKey: 'sk-test',
        baseUrl: '',
        model: 'gpt-4o',
      },
      isFormValid: mockIsFormValid,
    });

    render(<AISettingsPanel />);

    const saveButton = screen.getByText('Save Settings');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockSaveConfiguration).toHaveBeenCalled();
    });
  });

  it('calls testConnection when test button is clicked', async () => {
    mockTestConnection.mockResolvedValue('Connection successful');

    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      providerStatus: {
        ...defaultHookReturn.providerStatus,
        isConfigured: true,
      },
    });

    render(<AISettingsPanel />);

    const testButton = screen.getByText('Test Connection');
    fireEvent.click(testButton);

    await waitFor(() => {
      expect(mockTestConnection).toHaveBeenCalled();
    });
  });

  it('shows connected status when configured and available', () => {
    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      providerStatus: {
        ...defaultHookReturn.providerStatus,
        isConfigured: true,
        isAvailable: true,
      },
    });

    render(<AISettingsPanel />);

    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('shows error status when there is an error', () => {
    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      providerStatus: {
        ...defaultHookReturn.providerStatus,
        errorMessage: 'Invalid API key',
      },
    });

    render(<AISettingsPanel />);

    expect(screen.getByText(/Error: Invalid API key/)).toBeInTheDocument();
  });

  it('disables save button when form is invalid', () => {
    mockIsFormValid.mockReturnValue(false);

    render(<AISettingsPanel />);

    const saveButton = screen.getByText('Save Settings');
    expect(saveButton).toBeDisabled();
  });

  it('disables test button when not configured', () => {
    render(<AISettingsPanel />);

    const testButton = screen.getByText('Test Connection');
    expect(testButton).toBeDisabled();
  });

  it('shows current configuration when configured', () => {
    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      providerStatus: {
        providerType: 'openai',
        isConfigured: true,
        isAvailable: true,
        currentModel: 'gpt-4o',
        availableModels: ['gpt-4o', 'gpt-4'],
        errorMessage: null,
      },
    });

    render(<AISettingsPanel />);

    expect(screen.getByText('Current Configuration')).toBeInTheDocument();
    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
  });

  it('calls clearProvider when clear button is clicked', async () => {
    mockClearProvider.mockResolvedValue(undefined);

    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      providerStatus: {
        ...defaultHookReturn.providerStatus,
        isConfigured: true,
      },
    });

    render(<AISettingsPanel />);

    const clearButton = screen.getByText('Clear Configuration');
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(mockClearProvider).toHaveBeenCalled();
    });
  });

  it('shows loading state while configuring', () => {
    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      isConfiguring: true,
      formState: {
        providerType: 'openai',
        apiKey: 'sk-test',
        baseUrl: '',
        model: 'gpt-4o',
      },
    });

    render(<AISettingsPanel />);

    expect(screen.getByText('Saving...')).toBeInTheDocument();
  });

  it('shows loading state while testing connection', () => {
    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      isConnecting: true,
      providerStatus: {
        ...defaultHookReturn.providerStatus,
        isConfigured: true,
      },
    });

    render(<AISettingsPanel />);

    expect(screen.getByText('Testing...')).toBeInTheDocument();
  });

  it('calls onSaved callback when save succeeds', async () => {
    const onSaved = vi.fn();
    mockIsFormValid.mockReturnValue(true);
    mockSaveConfiguration.mockResolvedValue(undefined);

    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      formState: {
        providerType: 'openai',
        apiKey: 'sk-test',
        baseUrl: '',
        model: 'gpt-4o',
      },
      isFormValid: mockIsFormValid,
    });

    render(<AISettingsPanel onSaved={onSaved} />);

    const saveButton = screen.getByText('Save Settings');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
  });

  it('calls onError callback when save fails', async () => {
    const onError = vi.fn();
    mockIsFormValid.mockReturnValue(true);
    mockSaveConfiguration.mockRejectedValue(new Error('Save failed'));

    (useAISettings as Mock).mockReturnValue({
      ...defaultHookReturn,
      formState: {
        providerType: 'openai',
        apiKey: 'sk-test',
        baseUrl: '',
        model: 'gpt-4o',
      },
      isFormValid: mockIsFormValid,
    });

    render(<AISettingsPanel onError={onError} />);

    const saveButton = screen.getByText('Save Settings');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith('Save failed');
    });
  });
});
