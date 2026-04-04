import { forwardRef } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFeatureFlags, setFeatureFlag } from '@/config/featureFlags';
import { AgenticSidebarContent } from './AgenticSidebarContent';

vi.mock('./AgenticChat', () => ({
  AgenticChat: forwardRef(() => <div data-testid="agentic-chat">TPAO Runtime</div>),
}));

vi.mock('./AgentSessionRecoveryPanel', () => ({
  AgentSessionRecoveryPanel: vi.fn(() => <div data-testid="recovery-panel" />),
}));

vi.mock('./AgentSessionResumeHistoryPanel', () => ({
  AgentSessionResumeHistoryPanel: vi.fn(() => <div data-testid="resume-history-panel" />),
}));

vi.mock('./AgentSessionRecoveryStatus', () => ({
  AgentSessionRecoveryStatus: vi.fn(() => <div data-testid="recovery-status" />),
}));

vi.mock('./SessionList', () => ({
  SessionList: vi.fn(() => <div data-testid="session-list" />),
}));

vi.mock('@/agents/engine/adapters/llm/TauriLLMAdapter', () => ({
  createTauriLLMAdapter: vi.fn(() => ({
    isConfigured: () => true,
  })),
}));

vi.mock('@/agents/engine/adapters/tools/ToolRegistryAdapter', () => ({
  createToolRegistryAdapter: vi.fn(() => ({})),
}));

vi.mock('@/agents/engine/adapters/tools/BackendToolExecutor', () => ({
  createBackendToolExecutor: vi.fn(() => ({})),
}));

vi.mock('@/hooks/useNewChat', () => ({
  useNewChat: vi.fn(() => ({
    newChat: vi.fn(),
    canCreateNew: true,
  })),
}));

describe('AgenticSidebarContent', () => {
  const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        store = {};
      }),
    };
  })();

  beforeEach(() => {
    vi.stubGlobal('localStorage', localStorageMock);
    localStorageMock.clear();
    resetFeatureFlags();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should render the canonical TPAO runtime by default', () => {
    render(<AgenticSidebarContent />);

    expect(screen.getByTestId('agentic-chat')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-runtime-disabled-state')).not.toBeInTheDocument();
  });

  it('should keep the canonical runtime selected when USE_AGENT_LOOP is enabled', () => {
    setFeatureFlag('USE_AGENT_LOOP', true);

    render(<AgenticSidebarContent />);

    expect(screen.getByTestId('agentic-chat')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-runtime-disabled-state')).not.toBeInTheDocument();
  });

  it('should render an explicit disabled state when the canonical runtime is disabled', () => {
    setFeatureFlag('USE_AGENTIC_ENGINE', false);
    setFeatureFlag('USE_AGENT_LOOP', true);

    render(<AgenticSidebarContent />);

    expect(screen.getByTestId('agent-runtime-disabled-state')).toBeInTheDocument();
    expect(screen.getByText('AI runtime is disabled')).toBeInTheDocument();
    expect(
      screen.getByText('Enable `USE_AGENTIC_ENGINE` to restore the canonical TPAO runtime.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('agentic-chat')).not.toBeInTheDocument();
  });
});
