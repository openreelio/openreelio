import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ConversationMessage } from '@/agents/engine/core/conversation';
import { AgentArtifactDetailPanel } from './AgentArtifactDetailPanel';

describe('AgentArtifactDetailPanel', () => {
  it('renders tool detail for the selected tool focus', () => {
    const messages: ConversationMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            stepId: 's1',
            tool: 'delete_clip',
            args: { clipId: 'clip-1' },
            description: 'Delete clip-1',
            riskLevel: 'medium',
            status: 'completed',
          },
          {
            type: 'tool_result',
            stepId: 's1',
            tool: 'delete_clip',
            success: true,
            duration: 25,
          },
        ],
        timestamp: 1,
      },
    ];

    render(
      <AgentArtifactDetailPanel
        messages={messages}
        focus={{ kind: 'tool', value: 'delete_clip' }}
      />,
    );

    expect(screen.getByTestId('agent-artifact-detail-panel')).toBeInTheDocument();
    expect(screen.getByText('Action Details')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Medium impact')).toBeInTheDocument();
    expect(screen.getByTestId('tool-call-part')).toBeInTheDocument();
    expect(screen.getByTestId('tool-result-part')).toBeInTheDocument();
  });

  it('renders summary detail for the selected summary focus', () => {
    const messages: ConversationMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'compaction',
            summary: 'Summarized the earlier editing discussion.',
            auto: true,
          },
        ],
        timestamp: 1,
      },
    ];

    render(<AgentArtifactDetailPanel messages={messages} focus={{ kind: 'summary' }} />);

    expect(screen.getByText('Earlier Context Summary')).toBeInTheDocument();
    expect(screen.getByText('Created automatically')).toBeInTheDocument();
    expect(screen.getByText('Summarized the earlier editing discussion.')).toBeInTheDocument();
  });
});
