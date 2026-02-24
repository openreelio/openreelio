/**
 * ChatInputArea
 *
 * Input area for the agentic chat, including the PromptInput,
 * stop button, queue indicator, and phase indicator.
 * Extracted from AgenticChat to keep components under 200 lines.
 */

import { Square } from 'lucide-react';
import { PromptInput } from './PromptInput';

// =============================================================================
// Types
// =============================================================================

export interface ChatInputAreaProps {
  input: string;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  placeholder: string;
  disabled: boolean;
  isRunning: boolean;
  stopState: 'idle' | 'stopping';
  /** Phase label from either the TPAO or agent loop hook */
  phase: string;
  queueSize: number;
}

// =============================================================================
// Helpers
// =============================================================================

function getPhaseLabel(phase: string, stopState: 'idle' | 'stopping'): string {
  if (stopState === 'stopping') return 'Stopping...';
  switch (phase) {
    case 'thinking':
      return 'Thinking...';
    case 'planning':
      return 'Planning...';
    case 'awaiting_approval':
      return 'Awaiting approval';
    case 'executing':
      return 'Executing...';
    case 'observing':
      return 'Observing results...';
    default:
      return phase.replace(/_/g, ' ');
  }
}

// =============================================================================
// Component
// =============================================================================

export function ChatInputArea({
  input,
  onInputChange,
  onSubmit,
  onStop,
  placeholder,
  disabled,
  isRunning,
  stopState,
  phase,
  queueSize,
}: ChatInputAreaProps) {
  return (
    <div className="border-t border-border-subtle p-4">
      {/* Queue indicator */}
      {queueSize > 0 && (
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-primary-500/10 text-primary-400 rounded-full">
            {queueSize} queued
          </span>
        </div>
      )}

      <div className="flex gap-2 items-end">
        <PromptInput
          value={input}
          onChange={onInputChange}
          onSubmit={onSubmit}
          placeholder={placeholder}
          disabled={disabled}
          className="flex-1"
        />

        {isRunning && (
          <button
            onClick={onStop}
            className={`p-2 rounded-lg transition-colors flex-shrink-0 ${
              stopState === 'stopping'
                ? 'bg-orange-600 hover:bg-red-600 text-white'
                : 'bg-red-600 hover:bg-red-500 text-white'
            }`}
            aria-label={
              stopState === 'stopping' ? 'Force stop' : 'Stop'
            }
            title={
              stopState === 'stopping'
                ? 'Click again to force stop'
                : 'Stop execution'
            }
            data-testid="stop-btn"
          >
            <Square className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Phase indicator */}
      {isRunning && (
        <div className="mt-2 flex items-center gap-2">
          <div className="w-2 h-2 bg-primary-500 rounded-full animate-pulse" />
          <span className="text-xs text-text-tertiary">
            {getPhaseLabel(phase, stopState)}
          </span>
        </div>
      )}
    </div>
  );
}
