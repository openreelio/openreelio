/**
 * AssetContextMenu Component
 *
 * Context menu for asset operations including transcription.
 * Displays when right-clicking on an asset in the project explorer.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { MessageSquare, Trash2, Edit3, Loader2 } from 'lucide-react';
import type { AssetData } from '@/components/explorer/AssetItem';

// =============================================================================
// Types
// =============================================================================

export interface AssetContextMenuProps {
  /** Asset data */
  asset: AssetData;
  /** Whether the menu is open */
  isOpen: boolean;
  /** Menu position */
  position: { x: number; y: number };
  /** Callback when transcribe option is selected */
  onTranscribe: (asset: AssetData) => void;
  /** Callback when delete option is selected */
  onDelete: (asset: AssetData) => void;
  /** Optional callback when rename option is selected */
  onRename?: (asset: AssetData) => void;
  /** Callback when menu should close */
  onClose: () => void;
  /** Whether transcription is in progress for this asset */
  isTranscribing?: boolean;
  /** Whether transcription feature is available */
  isTranscriptionAvailable?: boolean;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if asset type supports transcription
 */
function supportsTranscription(kind: AssetData['kind']): boolean {
  return kind === 'video' || kind === 'audio';
}

// =============================================================================
// Component
// =============================================================================

export const AssetContextMenu: React.FC<AssetContextMenuProps> = ({
  asset,
  isOpen,
  position,
  onTranscribe,
  onDelete,
  onRename,
  onClose,
  isTranscribing = false,
  isTranscriptionAvailable = true,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    // Use setTimeout to avoid closing immediately on the same click that opened the menu
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Handle action click
  const handleAction = useCallback(
    (action: () => void) => {
      action();
      onClose();
    },
    [onClose]
  );

  // Don't render if not open
  if (!isOpen) {
    return null;
  }

  const canTranscribe = supportsTranscription(asset.kind) && isTranscriptionAvailable && !isTranscribing;

  return (
    <div
      ref={menuRef}
      data-testid="asset-context-menu"
      role="menu"
      className="fixed z-50 bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
    >
      {/* Transcribe Option (for video/audio only) */}
      {supportsTranscription(asset.kind) && (
        <button
          role="menuitem"
          tabIndex={0}
          onClick={() => handleAction(() => onTranscribe(asset))}
          disabled={!canTranscribe}
          className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors
            ${
              canTranscribe
                ? 'text-white hover:bg-neutral-700'
                : 'text-neutral-500 cursor-not-allowed'
            }`}
        >
          {isTranscribing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <MessageSquare className="w-4 h-4" />
          )}
          <span>{isTranscribing ? 'Transcribing...' : 'Transcribe'}</span>
        </button>
      )}

      {/* Separator */}
      {supportsTranscription(asset.kind) && (
        <div className="border-t border-neutral-600 my-1" />
      )}

      {/* Rename Option */}
      {onRename && (
        <button
          role="menuitem"
          tabIndex={0}
          onClick={() => handleAction(() => onRename(asset))}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white text-left hover:bg-neutral-700 transition-colors"
        >
          <Edit3 className="w-4 h-4" />
          <span>Rename</span>
        </button>
      )}

      {/* Delete Option */}
      <button
        role="menuitem"
        tabIndex={0}
        onClick={() => handleAction(() => onDelete(asset))}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 text-left hover:bg-red-900/30 transition-colors"
      >
        <Trash2 className="w-4 h-4" />
        <span>Delete</span>
      </button>
    </div>
  );
};

export default AssetContextMenu;
