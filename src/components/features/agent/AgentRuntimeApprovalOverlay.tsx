import type { Plan } from '@/agents/engine';
import type { AgentRuntimePermissionRequest } from './AgentComposerTray';
import { ApprovalPartRenderer } from './parts/ApprovalPartRenderer';
import { ToolApprovalPartRenderer } from './parts/ToolApprovalPartRenderer';

interface AgentRuntimeApprovalOverlayProps {
  pendingPlan: Plan | null;
  pendingToolPermissionRequest: AgentRuntimePermissionRequest | null;
  onApprove: () => void;
  onReject: (reason?: string) => void;
  onToolAllow: () => void;
  onToolAllowAlways: () => void;
  onToolDeny: () => void;
}

export function AgentRuntimeApprovalOverlay({
  pendingPlan,
  pendingToolPermissionRequest,
  onApprove,
  onReject,
  onToolAllow,
  onToolAllowAlways,
  onToolDeny,
}: AgentRuntimeApprovalOverlayProps) {
  if (!pendingPlan && !pendingToolPermissionRequest) {
    return null;
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-2 bottom-2 z-40 flex justify-center"
      data-testid="agent-runtime-approval-overlay"
      aria-live="assertive"
    >
      <div
        className="pointer-events-auto max-h-[min(18rem,calc(100%_-_1rem))] w-full max-w-md overflow-hidden rounded-xl border border-border-subtle bg-surface-elevated shadow-2xl"
        role="dialog"
        aria-modal="false"
        aria-label="Agent approval request"
      >
        <div className="border-b border-border-subtle px-3 py-2">
          <p className="text-xs font-medium text-text-primary">Approval Required</p>
          <p className="mt-0.5 text-[11px] text-text-tertiary">
            Review the request before the agent changes the project.
          </p>
        </div>
        <div className="max-h-[calc(18rem_-_3.5rem)] space-y-2 overflow-y-auto p-3">
          {pendingPlan && (
            <ApprovalPartRenderer
              part={{
                type: 'approval',
                plan: pendingPlan,
                status: 'pending',
              }}
              onApprove={onApprove}
              onReject={onReject}
            />
          )}

          {pendingToolPermissionRequest && (
            <ToolApprovalPartRenderer
              part={{
                type: 'tool_approval',
                stepId: pendingToolPermissionRequest.id,
                tool: pendingToolPermissionRequest.tool,
                args: pendingToolPermissionRequest.args,
                description: pendingToolPermissionRequest.description,
                riskLevel: pendingToolPermissionRequest.riskLevel,
                status: 'pending',
              }}
              onAllow={onToolAllow}
              onAllowAlways={onToolAllowAlways}
              onDeny={onToolDeny}
            />
          )}
        </div>
      </div>
    </div>
  );
}
