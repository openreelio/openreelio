/**
 * CommandPalette Component
 *
 * VS Code-style command palette modal (Ctrl+Shift+P).
 * Provides fuzzy search across all available actions with keyboard navigation.
 */

import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { Search, Clock } from 'lucide-react';
import type { PaletteAction } from '@/stores/commandPaletteStore';
import type { UseCommandPaletteReturn } from '@/hooks/useCommandPalette';

// =============================================================================
// Types
// =============================================================================

export interface CommandPaletteProps {
  /** Command palette hook return value */
  palette: UseCommandPaletteReturn;
}

// =============================================================================
// Sub-Components
// =============================================================================

/** Single action row in the palette list */
function ActionItem({
  action,
  isSelected,
  onSelect,
  onHover,
}: {
  action: PaletteAction;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      tabIndex={-1}
      id={`palette-action-${action.id}`}
      className={`w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors ${
        isSelected ? 'bg-blue-600/30 text-white' : 'text-slate-300 hover:bg-slate-700/50'
      }`}
      onClick={() => onSelect(action.id)}
      onMouseEnter={() => onHover(action.id)}
      onFocus={() => onHover(action.id)}
      data-testid={`palette-action-${action.id}`}
      role="option"
      aria-selected={isSelected}
    >
      <span className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-slate-500 w-16">
          {action.category}
        </span>
        <span className="truncate">{action.label}</span>
      </span>
      {action.shortcut && (
        <kbd className="shrink-0 ml-3 px-1.5 py-0.5 text-[11px] font-mono text-slate-400 bg-slate-700/60 rounded border border-slate-600">
          {action.shortcut}
        </kbd>
      )}
    </button>
  );
}

// =============================================================================
// Component
// =============================================================================

export function CommandPalette({ palette }: CommandPaletteProps): JSX.Element | null {
  const {
    isOpen,
    searchQuery,
    selectedIndex,
    filteredActions,
    recentActions,
    close,
    setSearchQuery,
    setSelectedIndex,
    executeAction,
  } = palette;

  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const hasRecent = recentActions.length > 0 && !searchQuery.trim();
  const visibleActionState = useMemo(() => {
    if (!hasRecent) {
      return {
        primaryActions: filteredActions,
        visibleActions: filteredActions,
        recentCount: 0,
      };
    }

    const recentActionIds = new Set(recentActions.map((action) => action.id));
    const primaryActions = filteredActions.filter((action) => !recentActionIds.has(action.id));

    return {
      primaryActions,
      visibleActions: [...recentActions, ...primaryActions],
      recentCount: recentActions.length,
    };
  }, [filteredActions, hasRecent, recentActions]);

  const { primaryActions, visibleActions, recentCount } = visibleActionState;
  const totalItems = visibleActions.length;

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      const rafId = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(rafId);
    }
  }, [isOpen]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[aria-selected="true"]');
    if (selected && typeof selected.scrollIntoView === 'function') {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          close();
          break;

        case 'ArrowDown':
          e.preventDefault();
          if (totalItems === 0) {
            break;
          }
          setSelectedIndex(selectedIndex < totalItems - 1 ? selectedIndex + 1 : 0);
          break;

        case 'ArrowUp':
          e.preventDefault();
          if (totalItems === 0) {
            break;
          }
          setSelectedIndex(selectedIndex > 0 ? selectedIndex - 1 : totalItems - 1);
          break;

        case 'Enter':
          e.preventDefault();
          if (visibleActions[selectedIndex]) {
            executeAction(visibleActions[selectedIndex].id);
          }
          break;
      }
    },
    [close, setSelectedIndex, selectedIndex, totalItems, visibleActions, executeAction],
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) {
        close();
      }
    },
    [close],
  );

  const handleActionHover = useCallback(
    (actionId: string) => {
      const idx = visibleActions.findIndex((action) => action.id === actionId);
      if (idx >= 0) {
        setSelectedIndex(idx);
      }
    },
    [visibleActions, setSelectedIndex],
  );

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh] bg-black/50"
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
      data-testid="command-palette"
    >
      <div className="w-full max-w-lg rounded-lg bg-slate-800 border border-slate-600 shadow-2xl flex flex-col overflow-hidden">
        {/* Search Input */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-700">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Type a command..."
            className="w-full bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none"
            data-testid="command-palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={
              visibleActions[selectedIndex]
                ? `palette-action-${visibleActions[selectedIndex].id}`
                : undefined
            }
          />
          <kbd className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono text-slate-500 bg-slate-700/40 rounded border border-slate-700">
            Esc
          </kbd>
        </div>

        {/* Action List */}
        <div
          ref={listRef}
          id="command-palette-list"
          className="max-h-80 overflow-y-auto"
          role="listbox"
          data-testid="command-palette-list"
        >
          {/* Recent Actions Section */}
          {hasRecent && (
            <>
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500 bg-slate-800/50">
                <Clock className="w-3 h-3" />
                Recent
              </div>
              {recentActions.map((a) => (
                <ActionItem
                  key={`recent-${a.id}`}
                  action={a}
                  isSelected={visibleActions[selectedIndex]?.id === a.id}
                  onSelect={executeAction}
                  onHover={handleActionHover}
                />
              ))}
              {primaryActions.length > 0 && <div className="h-px bg-slate-700 mx-2 my-1" />}
            </>
          )}

          {/* All Actions */}
          {totalItems > 0 ? (
            primaryActions.map((a, idx) => (
              <ActionItem
                key={a.id}
                action={a}
                isSelected={idx + recentCount === selectedIndex}
                onSelect={executeAction}
                onHover={handleActionHover}
              />
            ))
          ) : (
            <div className="px-4 py-8 text-center text-sm text-slate-500" data-testid="command-palette-empty">
              No matching commands
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-3 py-1.5 text-[10px] text-slate-500 border-t border-slate-700 bg-slate-800/50">
          <span>{totalItems} command{totalItems !== 1 ? 's' : ''}</span>
          <span className="flex items-center gap-2">
            <span>
              <kbd className="px-1 py-0.5 font-mono bg-slate-700/40 rounded">↑↓</kbd> navigate
            </span>
            <span>
              <kbd className="px-1 py-0.5 font-mono bg-slate-700/40 rounded">↵</kbd> execute
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
