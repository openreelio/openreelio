import type { AgentArtifactFocus } from './agentArtifactFocus';

interface AgentArtifactFocusBannerProps {
  focus: AgentArtifactFocus;
  onClear: () => void;
  className?: string;
}

function getLabel(focus: AgentArtifactFocus): string {
  if (focus.kind === 'tool') {
    return `Focused tool output: ${focus.value}`;
  }

  if (focus.kind === 'file') {
    return `Focused file output: ${focus.value}`;
  }

  return 'Focused summary output';
}

export function AgentArtifactFocusBanner({
  focus,
  onClear,
  className = '',
}: AgentArtifactFocusBannerProps) {
  return (
    <div
      className={`flex items-center justify-between gap-3 border-b border-border-subtle bg-primary-500/8 px-4 py-2 ${className}`}
      data-testid="agent-artifact-focus-banner"
    >
      <div>
        <p className="text-xs font-medium text-primary-300">{getLabel(focus)}</p>
        <p className="mt-0.5 text-[11px] text-text-tertiary">
          Jumped to the latest matching execution details in this session.
        </p>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="rounded-md border border-border-subtle bg-surface-base px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-surface-active"
        data-testid="agent-artifact-focus-clear-btn"
      >
        Clear
      </button>
    </div>
  );
}
