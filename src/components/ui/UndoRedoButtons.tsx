/**
 * UndoRedoButtons Component
 *
 * Provides undo and redo buttons for the application toolbar.
 * Uses the project store's undo/redo methods which handle backend sync.
 */

import { useCallback, useEffect, useState } from 'react';
import { Undo2, Redo2 } from 'lucide-react';
import { useProjectStore } from '@/stores';
import { createLogger } from '@/services/logger';

const logger = createLogger('UndoRedoButtons');

// =============================================================================
// Types
// =============================================================================

export interface UndoRedoButtonsProps {
  /** Additional CSS classes */
  className?: string;
  /** Callback when undo is performed */
  onUndo?: () => void;
  /** Callback when redo is performed */
  onRedo?: () => void;
}

// =============================================================================
// Component
// =============================================================================

export function UndoRedoButtons({
  className = '',
  onUndo,
  onRedo,
}: UndoRedoButtonsProps): JSX.Element {
  const {
    isLoaded,
    undo: storeUndo,
    redo: storeRedo,
    canUndo: storeCanUndo,
    canRedo: storeCanRedo,
  } = useProjectStore();

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  // Check undo/redo availability using store methods
  const checkAvailability = useCallback(async () => {
    if (!isLoaded) {
      setCanUndo(false);
      setCanRedo(false);
      return;
    }

    try {
      const [undoResult, redoResult] = await Promise.all([
        storeCanUndo(),
        storeCanRedo(),
      ]);
      setCanUndo(undoResult);
      setCanRedo(redoResult);
    } catch (error) {
      logger.error('Failed to check undo/redo availability', { error });
      setCanUndo(false);
      setCanRedo(false);
    }
  }, [isLoaded, storeCanUndo, storeCanRedo]);

  // Check availability on mount and when project changes
  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  // Poll for changes (could be optimized with events in future)
  useEffect(() => {
    if (!isLoaded) return;

    const interval = setInterval(() => {
      void checkAvailability();
    }, 1000);

    return () => clearInterval(interval);
  }, [isLoaded, checkAvailability]);

  // Handle undo using store method (which also syncs state from backend)
  const handleUndo = useCallback(async () => {
    if (!canUndo || isProcessing) return;

    setIsProcessing(true);
    try {
      await storeUndo();
      await checkAvailability();
      onUndo?.();
    } catch (error) {
      logger.error('Failed to undo', { error });
    } finally {
      setIsProcessing(false);
    }
  }, [canUndo, isProcessing, storeUndo, checkAvailability, onUndo]);

  // Handle redo using store method (which also syncs state from backend)
  const handleRedo = useCallback(async () => {
    if (!canRedo || isProcessing) return;

    setIsProcessing(true);
    try {
      await storeRedo();
      await checkAvailability();
      onRedo?.();
    } catch (error) {
      logger.error('Failed to redo', { error });
    } finally {
      setIsProcessing(false);
    }
  }, [canRedo, isProcessing, storeRedo, checkAvailability, onRedo]);

  // Keyboard shortcuts (Ctrl+Z / Ctrl+Shift+Z)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          void handleRedo();
        } else {
          void handleUndo();
        }
      }
      // Also support Ctrl+Y for redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        void handleRedo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo]);

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {/* Undo Button */}
      <button
        data-testid="undo-button"
        type="button"
        onClick={() => void handleUndo()}
        disabled={!canUndo || isProcessing}
        className={`
          p-1.5 rounded transition-colors
          ${canUndo && !isProcessing
            ? 'text-gray-300 hover:text-white hover:bg-gray-700'
            : 'text-gray-600 cursor-not-allowed'}
        `}
        title="Undo (Ctrl+Z)"
        aria-label="Undo"
      >
        <Undo2 className="w-4 h-4" />
      </button>

      {/* Redo Button */}
      <button
        data-testid="redo-button"
        type="button"
        onClick={() => void handleRedo()}
        disabled={!canRedo || isProcessing}
        className={`
          p-1.5 rounded transition-colors
          ${canRedo && !isProcessing
            ? 'text-gray-300 hover:text-white hover:bg-gray-700'
            : 'text-gray-600 cursor-not-allowed'}
        `}
        title="Redo (Ctrl+Shift+Z)"
        aria-label="Redo"
      >
        <Redo2 className="w-4 h-4" />
      </button>
    </div>
  );
}
