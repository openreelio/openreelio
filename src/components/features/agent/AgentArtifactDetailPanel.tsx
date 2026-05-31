import { useMemo } from 'react';
import type { ConversationMessage } from '@/agents/engine/core/conversation';
import { resolveArtifactFocusDetail, type AgentArtifactFocus } from './agentArtifactFocus';
import { ToolCallPartRenderer } from './parts/ToolCallPartRenderer';
import { ToolResultPartRenderer } from './parts/ToolResultPartRenderer';
import { ToolApprovalPartRenderer } from './parts/ToolApprovalPartRenderer';
import { PatchPartRenderer } from './parts/PatchPartRenderer';

function countPatchStats(diff: string): { additions: number; deletions: number } {
  const diffLines = diff.split('\n');
  return {
    additions: diffLines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    deletions: diffLines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
  };
}

function DetailChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border-subtle bg-surface-base px-2 py-0.5 text-[11px] text-text-secondary">
      {children}
    </span>
  );
}

interface AgentArtifactDetailPanelProps {
  messages: readonly ConversationMessage[];
  focus: AgentArtifactFocus | null;
  variant?: 'inline' | 'panel';
  className?: string;
}

export function AgentArtifactDetailPanel({
  messages,
  focus,
  variant = 'inline',
  className = '',
}: AgentArtifactDetailPanelProps) {
  const detail = useMemo(() => resolveArtifactFocusDetail(messages, focus), [focus, messages]);

  if (!detail) {
    return null;
  }

  const containerClassName =
    variant === 'panel'
      ? `h-full overflow-auto p-4 ${className}`
      : `max-h-72 shrink-0 overflow-y-auto border-b border-border-subtle bg-surface-elevated/80 px-4 py-3 ${className}`;
  const patchStats = detail.kind === 'file' ? countPatchStats(detail.patch.diff) : null;
  const toolStatus = detail.kind === 'tool' ? (detail.toolCall?.status ?? 'completed') : null;
  const toolRisk = detail.kind === 'tool' ? (detail.toolCall?.riskLevel ?? null) : null;

  const toolStatusLabel =
    toolStatus === 'completed'
      ? 'Completed'
      : toolStatus === 'failed'
        ? 'Needs attention'
        : toolStatus === 'running'
          ? 'Running'
          : 'Waiting';
  const toolImpactLabel =
    toolRisk === 'critical'
      ? 'High impact'
      : toolRisk === 'high'
        ? 'High impact'
        : toolRisk === 'medium'
          ? 'Medium impact'
          : toolRisk === 'low'
            ? 'Low impact'
            : null;

  return (
    <div className={containerClassName} data-testid="agent-artifact-detail-panel">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
          Activity Details
        </span>
        <span className="rounded-full border border-border-subtle bg-surface-base px-2 py-0.5 text-[11px] text-text-secondary">
          {new Date(detail.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {detail.kind === 'tool' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-text-primary">Action Details</span>
            <code className="rounded bg-surface-base px-1.5 py-0.5 text-xs text-text-secondary">
              {detail.value}
            </code>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DetailChip>{toolStatusLabel}</DetailChip>
            {toolImpactLabel && <DetailChip>{toolImpactLabel}</DetailChip>}
            {detail.approvals.length > 0 && (
              <DetailChip>{detail.approvals.length} approvals</DetailChip>
            )}
          </div>
          {detail.approvals.map((approval, index) => (
            <ToolApprovalPartRenderer key={`${approval.stepId}-${index}`} part={approval} />
          ))}
          {detail.toolCall && <ToolCallPartRenderer part={detail.toolCall} />}
          {detail.toolResult && <ToolResultPartRenderer part={detail.toolResult} />}
        </div>
      )}

      {detail.kind === 'file' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-text-primary">File Changes</span>
            <code className="rounded bg-surface-base px-1.5 py-0.5 text-xs text-text-secondary">
              {detail.value}
            </code>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DetailChip>
              {detail.patch.files.length} file{detail.patch.files.length === 1 ? '' : 's'}
            </DetailChip>
            <DetailChip>+{patchStats?.additions ?? 0}</DetailChip>
            <DetailChip>-{patchStats?.deletions ?? 0}</DetailChip>
          </div>
          {detail.patch.files.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {detail.patch.files.map((file) => (
                <code
                  key={file}
                  className={`rounded px-1.5 py-0.5 text-xs ${
                    file === detail.value
                      ? 'bg-primary-500/15 text-primary-300 ring-1 ring-primary-500/40'
                      : 'bg-surface-base text-text-secondary'
                  }`}
                >
                  {file}
                </code>
              ))}
            </div>
          )}
          <PatchPartRenderer part={detail.patch} />
        </div>
      )}

      {detail.kind === 'summary' && (
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-blue-300">Earlier Context Summary</span>
            <span className="text-xs text-blue-300/70">
              {detail.compaction.auto ? 'created automatically' : 'saved manually'}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <DetailChip>
              {detail.compaction.auto ? 'Created automatically' : 'Saved manually'}
            </DetailChip>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
            {detail.compaction.summary}
          </p>
        </div>
      )}
    </div>
  );
}
