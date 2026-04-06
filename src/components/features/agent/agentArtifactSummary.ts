import type { ConversationMessage } from '@/agents/engine/core/conversation';
import type { AgentArtifactFocus } from './agentArtifactFocus';

export interface AgentArtifactSessionSummary {
  toolRuns: number;
  touchedFiles: number;
  recentTools: string[];
  recentFiles: string[];
  hasCompaction: boolean;
}

export function buildAgentArtifactSessionSummary(
  messages: readonly ConversationMessage[],
): AgentArtifactSessionSummary {
  const recentFiles: string[] = [];
  const recentTools: string[] = [];
  const seenFiles = new Set<string>();
  const seenTools = new Set<string>();

  let toolRuns = 0;
  let hasCompaction = false;

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message.role !== 'assistant') {
      continue;
    }

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];

      if (part.type === 'tool_call') {
        toolRuns += 1;
        if (!seenTools.has(part.tool) && recentTools.length < 4) {
          seenTools.add(part.tool);
          recentTools.push(part.tool);
        }
      }

      if (part.type === 'patch') {
        for (const file of part.files) {
          if (!seenFiles.has(file) && recentFiles.length < 4) {
            seenFiles.add(file);
            recentFiles.push(file);
          } else {
            seenFiles.add(file);
          }
        }
      }

      if (part.type === 'compaction') {
        hasCompaction = true;
      }
    }
  }

  return {
    toolRuns,
    touchedFiles: seenFiles.size,
    recentTools,
    recentFiles,
    hasCompaction,
  };
}

export function resolvePreferredArtifactFocus(
  summary: AgentArtifactSessionSummary,
): AgentArtifactFocus | null {
  if (summary.recentFiles.length > 0) {
    return { kind: 'file', value: summary.recentFiles[0] };
  }

  if (summary.recentTools.length > 0) {
    return { kind: 'tool', value: summary.recentTools[0] };
  }

  if (summary.hasCompaction) {
    return { kind: 'summary' };
  }

  return null;
}
