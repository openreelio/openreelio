/**
 * PatchPartRenderer
 *
 * Renders code/file diffs as an inline diff viewer.
 * Shows affected files and unified diff content.
 */

import { useState } from 'react';
import type { PatchPart } from '@/agents/engine/core/conversation';

interface PatchPartRendererProps {
  part: PatchPart;
  className?: string;
}

function DiffLine({ line }: { line: string }) {
  let lineClass = 'text-text-secondary';

  if (line.startsWith('+') && !line.startsWith('+++')) {
    lineClass = 'text-green-400 bg-green-500/10';
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    lineClass = 'text-red-400 bg-red-500/10';
  } else if (line.startsWith('@@')) {
    lineClass = 'text-blue-400 bg-blue-500/10';
  } else if (line.startsWith('diff ') || line.startsWith('index ')) {
    lineClass = 'text-text-tertiary';
  }

  return <div className={`px-2 ${lineClass}`}>{line || '\u00A0'}</div>;
}

export function PatchPartRenderer({ part, className = '' }: PatchPartRendererProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const diffLines = part.diff.split('\n');
  const additions = diffLines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const deletions = diffLines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

  return (
    <div
      className={`border border-border-subtle rounded-lg overflow-hidden ${className}`}
      data-testid="patch-part"
    >
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-elevated transition-colors"
        aria-expanded={isExpanded}
      >
        <span className="text-xs text-text-tertiary">
          {isExpanded ? '\u25BC' : '\u25B6'}
        </span>
        <span className="text-xs font-mono text-text-secondary">
          {part.files.length === 1 ? part.files[0] : `${part.files.length} files`}
        </span>
        <span className="flex-1" />
        {additions > 0 && (
          <span className="text-xs text-green-400">+{additions}</span>
        )}
        {deletions > 0 && (
          <span className="text-xs text-red-400">-{deletions}</span>
        )}
      </button>

      {isExpanded && (
        <div className="border-t border-border-subtle overflow-x-auto">
          <pre className="text-xs font-mono leading-relaxed">
            {diffLines.map((line, i) => (
              <DiffLine key={i} line={line} />
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
