import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';

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
    if (!userOverrodeOpenStateRef.current) {
      setIsOpen(defaultOpen);
    }
  }, [defaultOpen, highlighted]);

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
      className={`overflow-hidden rounded-lg border bg-surface-base/40 ${
        highlighted ? 'border-primary-500/40 ring-1 ring-primary-500/20' : 'border-border-subtle'
      } ${className}`}
      data-testid="assistant-artifact-group"
    >
      <button
        type="button"
        onClick={() => {
          userOverrodeOpenStateRef.current = true;
          setIsOpen((prev) => !prev);
        }}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-active"
        aria-expanded={isOpen}
        data-testid="assistant-artifact-toggle"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform ${
            isOpen ? 'rotate-90' : ''
          }`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-text-secondary">Work Details</span>
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
        <div
          className="max-h-72 space-y-2 overflow-y-auto overscroll-contain border-t border-border-subtle px-2.5 py-2"
          data-testid="assistant-artifact-group-body"
        >
          {children}
        </div>
      )}
    </div>
  );
}
