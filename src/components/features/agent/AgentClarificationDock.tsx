interface AgentClarificationDockProps {
  question: string;
  className?: string;
}

export function AgentClarificationDock({ question, className = '' }: AgentClarificationDockProps) {
  return (
    <div
      className={`rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-3 py-3 ${className}`}
      data-testid="agent-clarification-dock"
    >
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-yellow-300">
          Clarification Needed
        </span>
      </div>
      <p className="mt-2 text-sm text-yellow-50">{question}</p>
      <p className="mt-2 text-xs text-yellow-200/80">
        Reply in the composer below to continue the session.
      </p>
    </div>
  );
}
