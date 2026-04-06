import { describe, expect, it } from 'vitest';
import type { ConversationMessage } from '@/agents/engine/core/conversation';
import { messageMatchesArtifactFocus, resolveArtifactFocusDetail } from './agentArtifactFocus';

describe('agentArtifactFocus', () => {
  it('does not match tool focus against approval-only messages', () => {
    const approvalMessage: ConversationMessage = {
      id: 'msg-approval',
      role: 'assistant',
      parts: [
        {
          type: 'tool_approval',
          stepId: 's1',
          tool: 'delete_clip',
          args: { clipId: 'clip-1' },
          description: 'Delete clip-1',
          riskLevel: 'medium',
          status: 'pending',
        },
      ],
      timestamp: 1,
    };

    expect(
      messageMatchesArtifactFocus(approvalMessage, { kind: 'tool', value: 'delete_clip' }),
    ).toBe(false);
  });

  it('resolves the latest matching tool execution detail', () => {
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
            duration: 50,
          },
        ],
        timestamp: 2,
      },
      {
        id: 'msg-2',
        role: 'assistant',
        parts: [
          {
            type: 'tool_approval',
            stepId: 's2',
            tool: 'delete_clip',
            args: { clipId: 'clip-2' },
            description: 'Delete clip-2',
            riskLevel: 'medium',
            status: 'pending',
          },
        ],
        timestamp: 3,
      },
    ];

    const detail = resolveArtifactFocusDetail(messages, { kind: 'tool', value: 'delete_clip' });

    expect(detail).not.toBeNull();
    expect(detail?.messageId).toBe('msg-1');
    if (detail?.kind === 'tool') {
      expect(detail.approvals).toHaveLength(0);
      expect(detail.toolCall).not.toBeNull();
      expect(detail.toolResult).not.toBeNull();
    }
  });
});
