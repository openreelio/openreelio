import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@/agents/engine/core/conversation';
import { AgentSessionArtifactSummary } from './AgentSessionArtifactSummary';

describe('AgentSessionArtifactSummary', () => {
  it('renders nothing when the session has no artifacts', () => {
    const messages: ConversationMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [{ type: 'text', content: 'No artifacts yet.' }],
        timestamp: Date.now(),
      },
    ];

    const { container } = render(<AgentSessionArtifactSummary messages={messages} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('summarizes recent tools, files, and compaction state', () => {
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
            type: 'patch',
            diff: 'diff --git a/src/foo.ts b/src/foo.ts',
            files: ['src/foo.ts', 'src/bar.ts'],
          },
          {
            type: 'compaction',
            summary: 'Previous turns summarized',
            auto: true,
          },
        ],
        timestamp: Date.now(),
      },
    ];

    render(<AgentSessionArtifactSummary messages={messages} />);

    expect(screen.getByTestId('agent-session-artifact-summary')).toBeInTheDocument();
    expect(screen.getByText('Session Outputs')).toBeInTheDocument();
    expect(screen.getByText('1 tool run')).toBeInTheDocument();
    expect(screen.getByText('2 files')).toBeInTheDocument();
    expect(screen.getByText('summary available')).toBeInTheDocument();
    expect(screen.getByText('src/foo.ts')).toBeInTheDocument();
    expect(screen.getByText('delete_clip')).toBeInTheDocument();
  });

  it('emits artifact focus selections when chips are clicked', async () => {
    const user = userEvent.setup();
    const onSelectArtifact = vi.fn();
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
            type: 'patch',
            diff: 'diff --git a/src/foo.ts b/src/foo.ts',
            files: ['src/foo.ts'],
          },
          {
            type: 'compaction',
            summary: 'Previous turns summarized',
            auto: true,
          },
        ],
        timestamp: Date.now(),
      },
    ];

    render(<AgentSessionArtifactSummary messages={messages} onSelectArtifact={onSelectArtifact} />);

    await user.click(screen.getByTestId('artifact-tool-delete_clip'));
    await user.click(screen.getByTestId('artifact-file-src/foo.ts'));
    await user.click(screen.getByTestId('artifact-summary-chip'));

    expect(onSelectArtifact).toHaveBeenNthCalledWith(1, { kind: 'tool', value: 'delete_clip' });
    expect(onSelectArtifact).toHaveBeenNthCalledWith(2, { kind: 'file', value: 'src/foo.ts' });
    expect(onSelectArtifact).toHaveBeenNthCalledWith(3, { kind: 'summary' });
  });

  it('counts unique files in the session output header', () => {
    const messages: ConversationMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        parts: [
          {
            type: 'patch',
            diff: 'diff --git a/src/foo.ts b/src/foo.ts',
            files: ['src/foo.ts'],
          },
        ],
        timestamp: Date.now(),
      },
      {
        id: 'msg-2',
        role: 'assistant',
        parts: [
          {
            type: 'patch',
            diff: 'diff --git a/src/foo.ts b/src/foo.ts',
            files: ['src/foo.ts'],
          },
        ],
        timestamp: Date.now() + 1,
      },
    ];

    render(<AgentSessionArtifactSummary messages={messages} />);

    expect(screen.getByText('1 file')).toBeInTheDocument();
  });
});
