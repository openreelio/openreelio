import type {
  CompactionPart,
  ConversationMessage,
  PatchPart,
  ToolApprovalPart,
  ToolCallPart,
  ToolResultPart,
} from '@/agents/engine/core/conversation';

export type AgentArtifactFocus =
  | { kind: 'tool'; value: string }
  | { kind: 'file'; value: string }
  | { kind: 'summary' };

export type ResolvedAgentArtifactDetail =
  | {
      kind: 'tool';
      value: string;
      messageId: string;
      timestamp: number;
      toolCall: ToolCallPart | null;
      toolResult: ToolResultPart | null;
      approvals: ToolApprovalPart[];
    }
  | {
      kind: 'file';
      value: string;
      messageId: string;
      timestamp: number;
      patch: PatchPart;
    }
  | {
      kind: 'summary';
      messageId: string;
      timestamp: number;
      compaction: CompactionPart;
    };

export function isSameArtifactFocus(
  left: AgentArtifactFocus | null,
  right: AgentArtifactFocus | null,
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right || left.kind !== right.kind) {
    return false;
  }

  if (left.kind === 'summary' && right.kind === 'summary') {
    return true;
  }

  return 'value' in left && 'value' in right && left.value === right.value;
}

export function messageMatchesArtifactFocus(
  message: ConversationMessage,
  focus: AgentArtifactFocus | null,
): boolean {
  if (!focus || message.role !== 'assistant') {
    return false;
  }

  return message.parts.some((part) => {
    if (focus.kind === 'tool') {
      return (
        (part.type === 'tool_call' || part.type === 'tool_result') && part.tool === focus.value
      );
    }

    if (focus.kind === 'file') {
      return part.type === 'patch' && part.files.includes(focus.value);
    }

    return part.type === 'compaction';
  });
}

export function resolveArtifactFocusDetail(
  messages: readonly ConversationMessage[],
  focus: AgentArtifactFocus | null,
): ResolvedAgentArtifactDetail | null {
  if (!focus) {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') {
      continue;
    }

    if (focus.kind === 'tool') {
      const toolCall =
        [...message.parts]
          .reverse()
          .find(
            (part): part is ToolCallPart => part.type === 'tool_call' && part.tool === focus.value,
          ) ?? null;
      const toolResult =
        [...message.parts]
          .reverse()
          .find(
            (part): part is ToolResultPart =>
              part.type === 'tool_result' && part.tool === focus.value,
          ) ?? null;
      const approvals = message.parts.filter(
        (part): part is ToolApprovalPart =>
          part.type === 'tool_approval' && part.tool === focus.value,
      );

      if (toolCall || toolResult) {
        return {
          kind: 'tool',
          value: focus.value,
          messageId: message.id,
          timestamp: message.timestamp,
          toolCall,
          toolResult,
          approvals,
        };
      }
    }

    if (focus.kind === 'file') {
      const patch =
        [...message.parts]
          .reverse()
          .find(
            (part): part is PatchPart => part.type === 'patch' && part.files.includes(focus.value),
          ) ?? null;

      if (patch) {
        return {
          kind: 'file',
          value: focus.value,
          messageId: message.id,
          timestamp: message.timestamp,
          patch,
        };
      }
    }

    if (focus.kind === 'summary') {
      const compaction =
        [...message.parts]
          .reverse()
          .find((part): part is CompactionPart => part.type === 'compaction') ?? null;

      if (compaction) {
        return {
          kind: 'summary',
          messageId: message.id,
          timestamp: message.timestamp,
          compaction,
        };
      }
    }
  }

  return null;
}
