import { useEffect, useMemo, useRef, useState } from 'react';

interface AssistantArtifactGroupProps {
  toolCallCount: number;
  toolResultCount: number;
  patchPartCount: number;
  patchFileCount: number;
  hasCompaction: boolean;
  hasRunningArtifacts: boolean;
  hasFailedArtifacts: boolean;
  defaultOpen: boolean;
  highlighted?: boolean;
  children: React.ReactNode;
  className?: string;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function AssistantArtifactGroup({
  toolCallCount,
  toolResultCount,
  patchPartCount,
  patchFileCount,
  hasCompaction,
  hasRunningArtifacts,
  hasFailedArtifacts,
  defaultOpen,
  highlighted = false,
  children,
  className = '',
}: AssistantArtifactGroupProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const userOverrodeOpenStateRef = useRef(false);

  useEffect(() => {
    if (highlighted) {
      setIsOpen(true);
      return;
    }

    if (hasRunningArtifacts || hasFailedArtifacts) {
      setIsOpen(true);
      return;
    }

    if (!userOverrodeOpenStateRef.current) {
      setIsOpen(defaultOpen);
    }
  }, [defaultOpen, hasFailedArtifacts, hasRunningArtifacts, highlighted]);

  const badges = useMemo(() => {
    const result: string[] = [];
    const toolCount = Math.max(toolCallCount, toolResultCount);

    if (toolCount > 0) {
      result.push(pluralize(toolCount, 'action'));
    }
    if (patchPartCount > 0) {
      result.push(pluralize(patchFileCount || patchPartCount, 'file'));
    }
    if (hasCompaction) {
      result.push('earlier context');
    }

    return result;
  }, [hasCompaction, patchFileCount, patchPartCount, toolCallCount, toolResultCount]);

  const status = hasFailedArtifacts
    ? { label: 'Attention', tone: 'border-red-500/20 bg-red-500/10 text-red-300' }
    : hasRunningArtifacts
      ? { label: 'Running', tone: 'border-primary-500/20 bg-primary-500/10 text-primary-300' }
      : { label: 'Completed', tone: 'border-green-500/20 bg-green-500/10 text-green-300' };

  return (
    <div
      className={`overflow-hidden rounded-xl border bg-surface-elevated/70 ${
        highlighted ? 'border-primary-500/40 ring-1 ring-primary-500/30' : 'border-border-subtle'
      } ${className}`}
      data-testid="assistant-artifact-group"
    >
      <button
        type="button"
        onClick={() => {
          userOverrodeOpenStateRef.current = true;
          setIsOpen((prev) => !prev);
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-active"
        aria-expanded={isOpen}
        data-testid="assistant-artifact-toggle"
      >
        <span className="text-xs text-text-tertiary">{isOpen ? '\u25BC' : '\u25B6'}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-[0.08em] text-text-tertiary">
              Work Details
            </span>
            <span
              className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${status.tone}`}
            >
              {status.label}
            </span>
          </div>
          {badges.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {badges.map((badge) => (
                <span
                  key={badge}
                  className="rounded-full border border-border-subtle bg-surface-base px-1.5 py-0.5 text-[10px] text-text-secondary"
                >
                  {badge}
                </span>
              ))}
            </div>
          )}
        </div>
      </button>

      {isOpen && (
        <div className="space-y-2 border-t border-border-subtle px-3 py-3">{children}</div>
      )}
    </div>
  );
}
