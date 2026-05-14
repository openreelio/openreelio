import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatInputArea } from './ChatInputArea';

const baseProps = {
  input: '',
  onInputChange: vi.fn(),
  onSubmit: vi.fn(),
  onStop: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onToolAllow: vi.fn(),
  onToolAllowAlways: vi.fn(),
  onToolDeny: vi.fn(),
  placeholder: 'Ask Codex...',
  disabled: false,
  isRunning: false,
  stopState: 'idle' as const,
  currentAgentName: 'Codex',
  isExperimentalSession: false,
  specialistDefinitions: [],
  phase: 'idle',
  runtimeSummary: {
    startedTools: 0,
    completedTools: 0,
    latestIteration: 0,
  },
  pendingPlan: null,
  pendingClarificationQuestion: null,
  pendingToolPermissionRequest: null,
  queueSize: 0,
};

describe('ChatInputArea', () => {
  it('renders a single compact permission decision surface while blocking input', () => {
    render(
      <ChatInputArea
        {...baseProps}
        isRunning
        phase="running"
        pendingToolPermissionRequest={{
          id: 'codex:12',
          tool: 'OpenReelio edit',
          args: { commandType: 'CreateTrack' },
          description: 'Add a B-roll track.',
          riskLevel: 'medium',
        }}
      />,
    );

    expect(screen.getByTestId('tool-approval-part')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-input')).toBeDisabled();
    expect(screen.queryByText(/Permission:/)).not.toBeInTheDocument();
  });
});
