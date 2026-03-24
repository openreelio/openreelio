/**
 * Undo History Panel — displays the undo/redo stack and allows
 * jumping to any point in the history.
 */
import { memo, useCallback, useRef, useEffect } from 'react';

import { History, RotateCcw, RotateCw, CircleDot, Circle } from 'lucide-react';

import { useUndoHistory, getCommandLabel } from '@/hooks/useUndoHistory';
import type { UndoHistoryEntry } from '@/types';

export interface UndoHistoryPanelProps {
  readOnly?: boolean;
}

const DESTRUCTIVE_PREFIXES = ['Remove', 'Delete', 'Unnest', 'Ungroup', 'Unlink', 'Clear'];

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function isDestructive(type: string): boolean {
  return (
    DESTRUCTIVE_PREFIXES.some((p) => type.startsWith(p)) ||
    type === 'Lift' ||
    type === 'RippleDelete' ||
    type === 'ExtractEdit'
  );
}

interface HistoryItemProps {
  entry: UndoHistoryEntry;
  isCurrent: boolean;
  isRedo: boolean;
  onClick: (index: number) => void;
  readOnly: boolean;
}

const HistoryItem = memo(function HistoryItem({
  entry,
  isCurrent,
  isRedo,
  onClick,
  readOnly,
}: HistoryItemProps) {
  const handleClick = useCallback(() => {
    if (!readOnly) onClick(entry.index);
  }, [entry.index, onClick, readOnly]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!readOnly && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        onClick(entry.index);
      }
    },
    [entry.index, onClick, readOnly],
  );

  const icon = isCurrent ? (
    <CircleDot className="w-3 h-3 shrink-0 text-primary-400" />
  ) : isDestructive(entry.commandType) ? (
    <RotateCcw className="w-3 h-3 shrink-0 text-red-400" />
  ) : (
    <RotateCw className="w-3 h-3 shrink-0 text-blue-400" />
  );

  return (
    <div
      role="option"
      aria-selected={isCurrent}
      tabIndex={readOnly ? -1 : 0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`flex items-center gap-2 px-3 py-1.5 text-xs transition-colors
        ${readOnly ? 'cursor-default' : 'cursor-pointer'}
        ${isCurrent ? 'bg-primary-600/30 text-primary-200 font-medium' : ''}
        ${isRedo ? 'opacity-40' : ''}
        ${!isCurrent && !readOnly ? 'hover:bg-white/5' : ''}`}
    >
      {icon}
      <span className="flex-1 truncate">{getCommandLabel(entry.commandType)}</span>
      <span className="text-[10px] text-gray-500 tabular-nums shrink-0">
        {formatTime(entry.timestamp)}
      </span>
    </div>
  );
});

export const UndoHistoryPanel = memo(function UndoHistoryPanel({
  readOnly = false,
}: UndoHistoryPanelProps) {
  const { undoEntries, redoEntries, currentIndex, loading, jumpToState } = useUndoHistory();
  const currentRef = useRef<HTMLDivElement>(null);
  const isEmpty = undoEntries.length === 0 && redoEntries.length === 0;

  useEffect(() => {
    if (currentRef.current && typeof currentRef.current.scrollIntoView === 'function') {
      currentRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [currentIndex]);

  const handleJump = useCallback(
    (idx: number) => void jumpToState(idx),
    [jumpToState],
  );

  const handleInitialClick = useCallback(() => {
    if (!readOnly) void jumpToState(-1);
  }, [jumpToState, readOnly]);

  const handleInitialKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!readOnly && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        void jumpToState(-1);
      }
    },
    [jumpToState, readOnly],
  );

  if (loading && isEmpty) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-gray-500">
        Loading history...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 shrink-0">
        <History className="w-3.5 h-3.5 text-gray-400" />
        <span className="text-xs font-medium text-gray-300">Undo History</span>
        <span className="text-[10px] text-gray-500 ml-auto">
          {undoEntries.length + redoEntries.length} operations
        </span>
      </div>

      <div role="listbox" aria-label="Undo history" className="flex-1 overflow-y-auto min-h-0">
        {/* Initial State */}
        <div ref={currentIndex === -1 ? currentRef : undefined}>
          <div
            role="option"
            aria-selected={currentIndex === -1}
            tabIndex={readOnly ? -1 : 0}
            onClick={handleInitialClick}
            onKeyDown={handleInitialKeyDown}
            className={`flex items-center gap-2 px-3 py-1.5 text-xs transition-colors
              ${readOnly ? 'cursor-default' : 'cursor-pointer'}
              ${currentIndex === -1 ? 'bg-primary-600/30 text-primary-200 font-medium' : 'text-gray-400'}
              ${currentIndex !== -1 && !readOnly ? 'hover:bg-white/5' : ''}`}
          >
            <Circle className="w-3 h-3 shrink-0 text-gray-500" />
            <span className="flex-1 italic">Initial State</span>
          </div>
        </div>

        {undoEntries.map((e) => (
          <div key={e.opId} ref={e.index === currentIndex ? currentRef : undefined}>
            <HistoryItem
              entry={e}
              isCurrent={e.index === currentIndex}
              isRedo={false}
              onClick={handleJump}
              readOnly={readOnly}
            />
          </div>
        ))}

        {redoEntries.map((e) => (
          <div key={e.opId}>
            <HistoryItem
              entry={e}
              isCurrent={false}
              isRedo={true}
              onClick={handleJump}
              readOnly={readOnly}
            />
          </div>
        ))}

        {isEmpty && (
          <div className="flex flex-col items-center justify-center py-8 text-gray-500">
            <History className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-xs">No operations yet</p>
            <p className="text-[10px] mt-1">Edits will appear here</p>
          </div>
        )}
      </div>
    </div>
  );
});
