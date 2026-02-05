/**
 * ChatInput Component
 *
 * Multi-line text input for AI chat with auto-resize,
 * Enter to send (Shift+Enter for newline), and streaming support.
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react';
import { useAIStore } from '@/stores/aiStore';
import { useTimelineStore, usePlaybackStore } from '@/stores';

// =============================================================================
// Constants
// =============================================================================

const MIN_ROWS = 1;
const MAX_ROWS = 6;
const LINE_HEIGHT_PX = 20;
const PADDING_PX = 16;

// =============================================================================
// Types
// =============================================================================

export interface ChatInputProps {
  /** Optional CSS class name */
  className?: string;
  /** Callback when message is sent */
  onSend?: (message: string) => void;
}

// =============================================================================
// Component
// =============================================================================

export function ChatInput({ className = '', onSend }: ChatInputProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Get store state and actions
  const isGenerating = useAIStore((state) => state.isGenerating);
  const sendMessage = useAIStore((state) => state.sendMessage);
  const cancelGeneration = useAIStore((state) => state.cancelGeneration);
  const clearChatHistory = useAIStore((state) => state.clearChatHistory);
  const addChatMessage = useAIStore((state) => state.addChatMessage);

  // Get playhead from PlaybackStore (single source of truth)
  const playhead = usePlaybackStore((state) => state.currentTime);
  // Get selection from TimelineStore
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const selectedTrackIds = useTimelineStore((state) => state.selectedTrackIds);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get correct scrollHeight
    textarea.style.height = 'auto';

    // Calculate new height
    const lineCount = Math.min(
      Math.max(
        Math.ceil((textarea.scrollHeight - PADDING_PX) / LINE_HEIGHT_PX),
        MIN_ROWS
      ),
      MAX_ROWS
    );
    const newHeight = lineCount * LINE_HEIGHT_PX + PADDING_PX;

    textarea.style.height = `${newHeight}px`;
  }, [input]);

  // Handle input change
  const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
  }, []);

  // Handle key down for Enter to send
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter without shift sends the message
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input, isGenerating]
  );

  // Handle slash commands
  const handleCommand = useCallback((command: string): boolean => {
    const cmd = command.toLowerCase();

    if (cmd === '/new' || cmd === '/clear') {
      clearChatHistory();
      addChatMessage('system', 'Started a new conversation.');
      return true;
    }

    if (cmd === '/help' || cmd === '/?') {
      addChatMessage('system', `**Available Commands:**
• /new or /clear - Start a new conversation
• /help or /? - Show this help message

**Tips:**
• Just type naturally to chat with the AI
• Ask for edits like "split clip at 5 seconds"
• Ask questions like "what clips are in the timeline?"
• The AI will ask for clarification if needed`);
      return true;
    }

    return false;
  }, [clearChatHistory, addChatMessage]);

  // Handle submit
  const handleSubmit = useCallback(() => {
    const trimmedInput = input.trim();
    if (!trimmedInput || isGenerating) return;

    // Check for slash commands
    if (trimmedInput.startsWith('/')) {
      if (handleCommand(trimmedInput)) {
        setInput('');
        return;
      }
      // Unknown command - show help
      addChatMessage('system', `Unknown command: ${trimmedInput}. Type /help for available commands.`);
      setInput('');
      return;
    }

    // Call onSend callback if provided
    onSend?.(trimmedInput);

    // Send message using unified agent (conversation mode)
    sendMessage(trimmedInput, {
      playheadPosition: playhead,
      selectedClips: selectedClipIds,
      selectedTracks: selectedTrackIds,
    });

    // Clear input
    setInput('');
  }, [
    input,
    isGenerating,
    handleCommand,
    addChatMessage,
    onSend,
    sendMessage,
    playhead,
    selectedClipIds,
    selectedTrackIds,
  ]);

  // Handle stop button
  const handleStop = useCallback(() => {
    cancelGeneration();
  }, [cancelGeneration]);

  const canSend = input.trim().length > 0 && !isGenerating;

  return (
    <div
      data-testid="chat-input"
      className={`border-t border-editor-border p-3 ${className}`}
    >
      <div className="relative">
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Message AI or type /help for commands..."
          disabled={isGenerating}
          rows={MIN_ROWS}
          className="w-full resize-none rounded-lg bg-editor-surface border border-editor-border px-3 py-2 pr-12 text-sm text-editor-text placeholder:text-editor-text-secondary focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ lineHeight: `${LINE_HEIGHT_PX}px` }}
          aria-label="Chat message input"
        />

        {/* Send/Stop button */}
        <div className="absolute right-2 bottom-2">
          {isGenerating ? (
            <button
              type="button"
              onClick={handleStop}
              className="p-1.5 rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors"
              aria-label="Stop generating"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSend}
              className="p-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              aria-label="Send message"
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>

      {/* Hint text */}
      <p className="mt-1.5 text-[10px] text-editor-text-secondary">
        Press <kbd className="px-1 py-0.5 rounded bg-editor-surface text-editor-text">Enter</kbd> to send,{' '}
        <kbd className="px-1 py-0.5 rounded bg-editor-surface text-editor-text">Shift+Enter</kbd> for new line
      </p>
    </div>
  );
}

// =============================================================================
// Icons
// =============================================================================

function SendIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}
