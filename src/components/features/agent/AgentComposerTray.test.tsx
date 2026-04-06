import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PlanStep } from '@/agents/engine';
import { AgentComposerTray } from './AgentComposerTray';

const plannerStep: PlanStep = {
  id: 'step-1',
  tool: 'delete_clip',
  args: { clipId: 'clip-1' },
  description: 'Delete the selected clip',
  riskLevel: 'high',
  estimatedDuration: 500,
};

describe('AgentComposerTray', () => {
  it('renders the current session agent and experimental badge', () => {
    render(
      <AgentComposerTray
        currentAgentName="Planner"
        currentAgentDescription="Read-only planning agent"
        isExperimentalSession
        isRunning={false}
        stopState="idle"
        phase="idle"
        queueSize={0}
        runtimeSummary={{ startedTools: 0, completedTools: 0, latestIteration: 0 }}
        specialistDefinitions={[]}
      />,
    );

    expect(screen.getByText('Planner')).toBeInTheDocument();
    expect(screen.getByText('Experimental')).toBeInTheDocument();
    expect(screen.getByText('Read-only planning agent')).toBeInTheDocument();
  });

  it('starts a specialist session from the menu', async () => {
    const user = userEvent.setup();
    const onStartSession = vi.fn();

    render(
      <AgentComposerTray
        currentAgentName="Editor"
        isExperimentalSession={false}
        isRunning={false}
        stopState="idle"
        phase="idle"
        queueSize={0}
        runtimeSummary={{ startedTools: 0, completedTools: 0, latestIteration: 0 }}
        specialistDefinitions={[
          {
            id: 'planner',
            name: 'Planner',
            description: 'Read-only planning agent',
          },
        ]}
        onStartSession={onStartSession}
      />,
    );

    await user.click(screen.getByTestId('agent-specialists-btn'));
    await user.click(screen.getByTestId('agent-specialist-option-planner'));

    expect(onStartSession).toHaveBeenCalledWith('planner');
  });

  it('surfaces pending tool permission in the runtime pill', () => {
    render(
      <AgentComposerTray
        currentAgentName="Editor"
        isExperimentalSession={false}
        isRunning={true}
        stopState="idle"
        phase="executing"
        queueSize={0}
        runtimeSummary={{ startedTools: 0, completedTools: 0, latestIteration: 0 }}
        pendingToolPermissionRequest={{
          id: plannerStep.id,
          tool: plannerStep.tool,
          args: plannerStep.args,
          description: plannerStep.description,
          riskLevel: plannerStep.riskLevel,
        }}
        specialistDefinitions={[]}
      />,
    );

    expect(screen.getByTestId('agent-runtime-pill')).toHaveTextContent('Permission: delete_clip');
  });
});
