/**
 * AIPromptPanel Component
 *
 * A panel for entering natural language commands to control video editing.
 * Integrates with the useAIAgent hook to analyze intent and manage proposals.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useAIAgent, type AIContext } from '@/hooks/useAIAgent';
import { useTimelineStore } from '@/stores';
import { ProposalDialog } from './ProposalDialog';

// =============================================================================
// Types
// =============================================================================

export interface AIPromptPanelProps {
  /** Optional callback when edit script is applied successfully */
  onEditApplied?: (opIds: string[]) => void;
  /** Optional callback when error occurs */
  onError?: (error: string) => void;
}

// =============================================================================
// Component
// =============================================================================

export const AIPromptPanel: React.FC<AIPromptPanelProps> = ({
  onEditApplied,
  onError,
}) => {
  const [inputValue, setInputValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    isLoading,
    error,
    currentProposal,
    analyzeIntent,
    applyEditScript,
    rejectProposal,
    clearError,
  } = useAIAgent();

  // Get context from stores
  const playhead = useTimelineStore((state) => state.playhead);
  const selectedClipIds = useTimelineStore((state) => state.selectedClipIds);
  const selectedTrackIds = useTimelineStore((state) => state.selectedTrackIds);

  // Build AI context
  const buildContext = useCallback((): AIContext => {
    return {
      playheadPosition: playhead,
      selectedClips: selectedClipIds,
      selectedTracks: selectedTrackIds,
      transcriptContext: null, // TODO: Add transcript support
    };
  }, [playhead, selectedClipIds, selectedTrackIds]);

  // Handle submit
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const trimmedInput = inputValue.trim();
      if (!trimmedInput || isLoading) return;

      try {
        // Add to history
        setHistory((prev) => [...prev.slice(-19), trimmedInput]);
        setHistoryIndex(-1);

        // Analyze intent
        const context = buildContext();
        await analyzeIntent(trimmedInput, context);

        // Clear input on success
        setInputValue('');
      } catch (err) {
        console.error('AI analysis failed:', err);
        if (onError) {
          onError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [inputValue, isLoading, buildContext, analyzeIntent, onError]
  );

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Navigate history with up/down arrows
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (history.length > 0) {
          const newIndex = historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
          setHistoryIndex(newIndex);
          setInputValue(history[history.length - 1 - newIndex] || '');
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex > 0) {
          const newIndex = historyIndex - 1;
          setHistoryIndex(newIndex);
          setInputValue(history[history.length - 1 - newIndex] || '');
        } else if (historyIndex === 0) {
          setHistoryIndex(-1);
          setInputValue('');
        }
      }
    },
    [history, historyIndex]
  );

  // Handle proposal approval
  const handleApprove = useCallback(async () => {
    if (!currentProposal) {
      throw new Error('No proposal to approve');
    }

    const result = await applyEditScript(currentProposal);

    if (result.success && onEditApplied) {
      onEditApplied(result.appliedOpIds);
    }

    return result;
  }, [currentProposal, applyEditScript, onEditApplied]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Handle error changes
  useEffect(() => {
    if (error && onError) {
      onError(error);
    }
  }, [error, onError]);

  // Example commands
  const exampleCommands = [
    'Cut the first 5 seconds',
    'Delete selected clips',
    'Move clip to 10 seconds',
    'Add clip at the end',
  ];

  return (
    <>
      <div className="p-4 bg-neutral-900 border-t border-neutral-700">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">🤖</span>
            <h3 className="text-sm font-medium text-white">AI Assistant</h3>
          </div>
          {error && (
            <button
              onClick={clearError}
              className="text-xs text-red-400 hover:text-red-300"
            >
              Clear error
            </button>
          )}
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-3 p-2 rounded bg-red-900/30 border border-red-700 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Input Form */}
        <form onSubmit={handleSubmit} className="relative">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command... (e.g., 'Cut the first 5 seconds')"
            disabled={isLoading}
            className="w-full px-4 py-2.5 pr-24 rounded-lg bg-neutral-800 border border-neutral-600 text-white placeholder-neutral-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            type="submit"
            disabled={isLoading || !inputValue.trim()}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1 rounded bg-blue-600 text-white text-sm hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
          >
            {isLoading ? (
              <>
                <span className="animate-spin">⏳</span>
                <span>Analyzing...</span>
              </>
            ) : (
              <>
                <span>⚡</span>
                <span>Run</span>
              </>
            )}
          </button>
        </form>

        {/* Example Commands */}
        <div className="mt-3">
          <p className="text-xs text-neutral-500 mb-2">Try:</p>
          <div className="flex flex-wrap gap-1.5">
            {exampleCommands.map((cmd) => (
              <button
                key={cmd}
                type="button"
                onClick={() => setInputValue(cmd)}
                disabled={isLoading}
                className="px-2 py-1 text-xs rounded bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {cmd}
              </button>
            ))}
          </div>
        </div>

        {/* Context Info */}
        <div className="mt-3 pt-3 border-t border-neutral-800 flex items-center gap-4 text-xs text-neutral-500">
          <span>
            📍 Playhead: {playhead.toFixed(2)}s
          </span>
          <span>
            🎬 Selected: {selectedClipIds.length} clip{selectedClipIds.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Proposal Dialog */}
      <ProposalDialog
        proposal={currentProposal}
        isApplying={isLoading}
        onApprove={handleApprove}
        onReject={rejectProposal}
      />
    </>
  );
};

export default AIPromptPanel;
