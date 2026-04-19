import { TerminalSquare } from 'lucide-react';
import { useTerminalStore } from '@/stores/terminalStore';

export function BottomTerminalControls(): JSX.Element {
  const groupOrder = useTerminalStore((state) => state.groupOrder);
  const openingSessionIds = useTerminalStore((state) => state.openingSessionIds);
  const toggleTerminal = useTerminalStore((state) => state.toggleTerminal);
  const hasTerminal = groupOrder.length > 0 || openingSessionIds.length > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => void toggleTerminal()}
        className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
          hasTerminal
            ? 'bg-editor-bg text-editor-text'
            : 'text-editor-text-muted hover:bg-editor-border hover:text-editor-text'
        }`}
        aria-label={hasTerminal ? 'Close terminal' : 'Open terminal'}
        title="Toggle terminal (Ctrl+`)"
      >
        <TerminalSquare className="h-3.5 w-3.5" />
        <span className="whitespace-nowrap">Terminal</span>
      </button>
    </>
  );
}
