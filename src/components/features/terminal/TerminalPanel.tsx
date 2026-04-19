import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Plus, X } from 'lucide-react';
import { useUIStore } from '@/stores';
import { useTerminalStore } from '@/stores/terminalStore';
import { isDesktopRuntimeAvailable } from '@/services/runtimeEnvironment';
import { TerminalViewport } from './TerminalViewport';

interface ContextMenuState {
  groupId: string;
  x: number;
  y: number;
}

function visibleGridStyle(count: number): CSSProperties {
  return {
    gridTemplateColumns: `repeat(${Math.max(count, 1)}, minmax(0, 1fr))`,
  };
}

function getSessionLabel(sessionIndex: number): string {
  return `Terminal ${sessionIndex + 1}`;
}

export function TerminalPanel(): JSX.Element {
  const sessions = useTerminalStore((state) => state.sessions);
  const groups = useTerminalStore((state) => state.groups);
  const groupOrder = useTerminalStore((state) => state.groupOrder);
  const visibleSessionIds = useTerminalStore((state) => state.visibleSessionIds);
  const activeGroupId = useTerminalStore((state) => state.activeGroupId);
  const openingSessionIds = useTerminalStore((state) => state.openingSessionIds);
  const lastError = useTerminalStore((state) => state.lastError);
  const selectGroup = useTerminalStore((state) => state.selectGroup);
  const splitGroup = useTerminalStore((state) => state.splitGroup);
  const closeGroup = useTerminalStore((state) => state.closeGroup);
  const createTerminal = useTerminalStore((state) => state.createTerminal);
  const openSettings = useUIStore((state) => state.openSettings);
  const isDesktopRuntime = isDesktopRuntimeAvailable();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handlePointerDown = () => setContextMenu(null);
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu]);

  const visibleSessions = useMemo(
    () => visibleSessionIds.map((sessionId) => sessions[sessionId]).filter(Boolean),
    [sessions, visibleSessionIds],
  );

  if (!isDesktopRuntime) {
    return (
      <div className="flex h-full items-center justify-center bg-editor-bg px-6 text-center">
        <div className="max-w-md rounded-xl border border-editor-border bg-editor-panel p-5">
          <h2 className="text-sm font-semibold text-editor-text">Desktop Runtime Required</h2>
          <p className="mt-2 text-sm text-editor-text-muted">
            Integrated terminal sessions run through the desktop runtime and are not available in a
            browser-only preview.
          </p>
        </div>
      </div>
    );
  }

  if (groupOrder.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-[#1e1e1e] px-6 text-center">
        <div className="max-w-md px-5 py-4">
          <h2 className="text-sm font-medium text-[#cccccc]">Terminal</h2>
          <p className="mt-2 text-sm leading-6 text-[#8c8c8c]">
            Use the footer terminal button or <code>Ctrl+`</code> to open the integrated terminal.
            When the terminal is open, use the <code>+</code> button in the tab bar to add another
            terminal tab.
          </p>
          <button
            type="button"
            onClick={() => openSettings('terminal')}
            className="mt-4 text-xs text-[#3794ff] transition-colors hover:text-[#4aa5ff]"
          >
            Terminal settings
          </button>
          {lastError && <p className="mt-4 text-xs text-[#f48771]">{lastError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[#1e1e1e] text-[#cccccc]">
      <div className="flex h-8 shrink-0 items-center border-b border-[#313131] bg-[#252526] px-1">
        <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
          {groupOrder.map((groupId, groupIndex) => {
            const group = groups[groupId];
            if (!group) {
              return null;
            }

            const isActive = activeGroupId === groupId;
            const isOpening = group.sessionIds.some((sessionId) =>
              openingSessionIds.includes(sessionId),
            );

            return (
              <div
                key={groupId}
                className={`group flex h-8 shrink-0 items-center border-r border-[#2a2a2a] px-2 text-xs ${
                  isActive ? 'bg-[#1e1e1e] text-[#ffffff]' : 'text-[#8c8c8c] hover:bg-[#2a2d2e]'
                }`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({ groupId, x: event.clientX, y: event.clientY });
                }}
              >
                <button
                  type="button"
                  onClick={() => selectGroup(groupId)}
                  className="flex min-w-0 items-center gap-2"
                  title={getSessionLabel(groupIndex)}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${isOpening ? 'bg-[#cca700]' : 'bg-[#3794ff]'}`}
                  />
                  <span className="truncate">{getSessionLabel(groupIndex)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void closeGroup(groupId)}
                  className="ml-2 rounded p-0.5 text-[#8c8c8c] opacity-0 transition hover:bg-[#3b3b3b] hover:text-[#cccccc] group-hover:opacity-100"
                  aria-label={`Close ${getSessionLabel(groupIndex)}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => void createTerminal()}
          className="ml-1 shrink-0 rounded p-1 text-[#8c8c8c] transition-colors hover:bg-[#2a2d2e] hover:text-[#cccccc]"
          aria-label="New terminal"
          title="New terminal"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden bg-[#313131]">
        <div className="grid h-full gap-px" style={visibleGridStyle(visibleSessions.length)}>
          {visibleSessions.map((session) => (
            <div key={session.id} className="min-h-0 bg-[#1e1e1e]">
              <TerminalViewport sessionId={session.id} />
            </div>
          ))}
        </div>
      </div>

      {lastError && (
        <div className="border-t border-[#5a1d1d] bg-[#2d1212] px-3 py-1 text-[11px] text-[#f48771]">
          {lastError}
        </div>
      )}

      {contextMenu && (
        <div
          className="fixed z-[70] min-w-[140px] border border-[#454545] bg-[#252526] py-1 text-xs text-[#cccccc] shadow-2xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              void splitGroup(contextMenu.groupId);
              setContextMenu(null);
            }}
            className="flex w-full items-center px-3 py-1.5 text-left hover:bg-[#04395e]"
          >
            Split
          </button>
          <button
            type="button"
            onClick={() => {
              void closeGroup(contextMenu.groupId);
              setContextMenu(null);
            }}
            className="flex w-full items-center px-3 py-1.5 text-left hover:bg-[#04395e]"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
