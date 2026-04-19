import { useEffect, useMemo, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useTerminalStore } from '@/stores/terminalStore';

interface TerminalViewportProps {
  sessionId: string;
}

const TERMINAL_THEME = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  cursor: '#aeafad',
  cursorAccent: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
  selectionBackground: '#264f78',
};

export function TerminalViewport({ sessionId }: TerminalViewportProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const renderedChunkIdRef = useRef(0);
  const session = useTerminalStore((state) => state.sessions[sessionId] ?? null);
  const writeToSession = useTerminalStore((state) => state.writeToSession);
  const resizeSession = useTerminalStore((state) => state.resizeSession);
  const bufferVersion = useMemo(() => session?.nextChunkId ?? 0, [session?.nextChunkId]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const terminal = new XTerm({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    renderedChunkIdRef.current = 0;
    terminal.focus();

    const dataSubscription = terminal.onData((data) => {
      void writeToSession(sessionId, data);
    });

    const syncSize = () => {
      if (!fitAddonRef.current || !terminalRef.current) {
        return;
      }

      fitAddonRef.current.fit();
      void resizeSession(sessionId, terminalRef.current.cols, terminalRef.current.rows);
    };

    syncSize();

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncSize);
    });
    observer.observe(containerRef.current);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      renderedChunkIdRef.current = 0;
    };
  }, [resizeSession, sessionId, writeToSession]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !session) {
      return;
    }

    const nextChunks = session.buffer.filter((chunk) => chunk.id > renderedChunkIdRef.current);
    if (nextChunks.length === 0) {
      return;
    }

    for (const chunk of nextChunks) {
      terminal.write(chunk.data);
    }

    renderedChunkIdRef.current =
      nextChunks[nextChunks.length - 1]?.id ?? renderedChunkIdRef.current;
    terminal.scrollToBottom();
  }, [bufferVersion, session]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden bg-[#1e1e1e]" />;
}
