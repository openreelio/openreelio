/**
 * AgentPermissionsSection Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentPermissionsSection } from './AgentPermissionsSection';

// Mock the permission store
const mockAddRule = vi.fn();
const mockRemoveRule = vi.fn();
const mockSetPreset = vi.fn();
const mockLoadDefaults = vi.fn();

let mockGlobalRules: Array<{
  id: string;
  pattern: string;
  permission: 'allow' | 'ask' | 'deny';
  scope: 'global';
}> = [];

vi.mock('@/stores/permissionStore', () => ({
  usePermissionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      globalRules: mockGlobalRules,
      addRule: mockAddRule,
      removeRule: mockRemoveRule,
      setPreset: mockSetPreset,
      loadDefaults: mockLoadDefaults,
    }),
}));

describe('AgentPermissionsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGlobalRules = [];
  });

  it('renders section header and description', () => {
    render(<AgentPermissionsSection />);

    expect(screen.getByText('Agent Permissions')).toBeInTheDocument();
    expect(
      screen.getByText(/Control which tools the AI agent can use/),
    ).toBeInTheDocument();
  });

  it('renders preset buttons', () => {
    render(<AgentPermissionsSection />);

    expect(screen.getByTestId('preset-restrictive')).toBeInTheDocument();
    expect(screen.getByTestId('preset-balanced')).toBeInTheDocument();
    expect(screen.getByTestId('preset-permissive')).toBeInTheDocument();
    expect(screen.getByTestId('preset-reset')).toBeInTheDocument();
  });

  it('calls setPreset when a preset button is clicked', () => {
    render(<AgentPermissionsSection />);

    fireEvent.click(screen.getByTestId('preset-balanced'));
    expect(mockSetPreset).toHaveBeenCalledWith('balanced');
  });

  it('calls loadDefaults when reset button is clicked', () => {
    render(<AgentPermissionsSection />);

    fireEvent.click(screen.getByTestId('preset-reset'));
    expect(mockLoadDefaults).toHaveBeenCalled();
  });

  it('shows empty state when no rules exist', () => {
    render(<AgentPermissionsSection />);

    expect(
      screen.getByText(/No rules configured/),
    ).toBeInTheDocument();
  });

  it('renders existing rules', () => {
    mockGlobalRules = [
      { id: '1', pattern: 'analyze_*', permission: 'allow', scope: 'global' },
      { id: '2', pattern: 'delete_*', permission: 'deny', scope: 'global' },
    ];

    render(<AgentPermissionsSection />);

    const rules = screen.getAllByTestId('permission-rule');
    expect(rules).toHaveLength(2);
    expect(screen.getByText('analyze_*')).toBeInTheDocument();
    expect(screen.getByText('delete_*')).toBeInTheDocument();
  });

  it('adds a new rule when form is submitted', () => {
    render(<AgentPermissionsSection />);

    const input = screen.getByTestId('new-rule-pattern');
    const addBtn = screen.getByTestId('add-rule-btn');

    fireEvent.change(input, { target: { value: 'split_*' } });
    fireEvent.click(addBtn);

    expect(mockAddRule).toHaveBeenCalledWith('split_*', 'ask', 'global');
  });

  it('adds a rule on Enter key', () => {
    render(<AgentPermissionsSection />);

    const input = screen.getByTestId('new-rule-pattern');
    fireEvent.change(input, { target: { value: 'trim_*' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockAddRule).toHaveBeenCalledWith('trim_*', 'ask', 'global');
  });

  it('does not add a rule when pattern is empty', () => {
    render(<AgentPermissionsSection />);

    const addBtn = screen.getByTestId('add-rule-btn');
    expect(addBtn).toBeDisabled();

    fireEvent.click(addBtn);
    expect(mockAddRule).not.toHaveBeenCalled();
  });

  it('removes a rule when delete button is clicked', () => {
    mockGlobalRules = [
      { id: 'rule-1', pattern: 'get_*', permission: 'allow', scope: 'global' },
    ];

    render(<AgentPermissionsSection />);

    fireEvent.click(screen.getByTestId('delete-rule-btn'));
    expect(mockRemoveRule).toHaveBeenCalledWith('rule-1');
  });

  it('allows changing the permission dropdown for new rules', () => {
    render(<AgentPermissionsSection />);

    const select = screen.getByTestId('new-rule-permission');
    fireEvent.change(select, { target: { value: 'deny' } });

    const input = screen.getByTestId('new-rule-pattern');
    fireEvent.change(input, { target: { value: 'dangerous_*' } });
    fireEvent.click(screen.getByTestId('add-rule-btn'));

    expect(mockAddRule).toHaveBeenCalledWith('dangerous_*', 'deny', 'global');
  });

  it('clears input after adding a rule', () => {
    render(<AgentPermissionsSection />);

    const input = screen.getByTestId('new-rule-pattern') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'test_*' } });
    fireEvent.click(screen.getByTestId('add-rule-btn'));

    expect(input.value).toBe('');
  });
});
