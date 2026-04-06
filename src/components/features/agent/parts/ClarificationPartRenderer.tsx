import type { ClarificationPart } from '@/agents/engine/core/conversation';

interface ClarificationPartRendererProps {
  part: ClarificationPart;
  className?: string;
}

export function ClarificationPartRenderer({
  part,
  className = '',
}: ClarificationPartRendererProps) {
  return (
    <div
      className={`rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-3 py-3 ${className}`}
      data-testid="clarification-part"
    >
      <div className="text-xs font-medium uppercase tracking-[0.08em] text-yellow-300">
        Clarification Needed
      </div>
      <p className="mt-2 text-sm text-text-primary">{part.question}</p>
      <p className="mt-2 text-xs text-text-tertiary">
        Answer in the composer to continue this session.
      </p>
    </div>
  );
}
