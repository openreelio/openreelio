/**
 * FileTreeContextMenu Component
 *
 * Context menu for file/folder operations in the workspace explorer.
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  FolderPlus,
  Pencil,
  Trash2,
  ExternalLink,
  Copy,
  Plus,
  MessageSquare,
  Loader2,
} from 'lucide-react';
import type { FileTreeEntry } from '@/types';

export interface FileTreeContextMenuProps {
  entry: FileTreeEntry;
  position: { x: number; y: number };
  onClose: () => void;
  onCreateFolder?: (parentPath: string) => void;
  onRename?: (entry: FileTreeEntry) => void;
  onDelete?: (entry: FileTreeEntry) => void;
  onRevealInExplorer?: (relativePath: string) => void;
  onCopyPath?: (relativePath: string) => void;
  onAddToTimeline?: (entry: FileTreeEntry) => void;
  onTranscribe?: (entry: FileTreeEntry) => void;
  isTranscribing?: boolean;
}

export function FileTreeContextMenu({
  entry,
  position,
  onClose,
  onCreateFolder,
  onRename,
  onDelete,
  onRevealInExplorer,
  onCopyPath,
  onAddToTimeline,
  onTranscribe,
  isTranscribing = false,
}: FileTreeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleCreateFolder = useCallback(() => {
    const parentPath = entry.isDirectory
      ? entry.relativePath
      : entry.relativePath.split('/').slice(0, -1).join('/');
    onCreateFolder?.(parentPath);
    onClose();
  }, [entry, onCreateFolder, onClose]);

  const handleRename = useCallback(() => {
    onRename?.(entry);
    onClose();
  }, [entry, onRename, onClose]);

  const handleDelete = useCallback(() => {
    onDelete?.(entry);
    onClose();
  }, [entry, onDelete, onClose]);

  const handleReveal = useCallback(() => {
    onRevealInExplorer?.(entry.relativePath);
    onClose();
  }, [entry.relativePath, onRevealInExplorer, onClose]);

  const handleCopyPath = useCallback(() => {
    onCopyPath?.(entry.relativePath);
    onClose();
  }, [entry.relativePath, onCopyPath, onClose]);

  const handleAddToTimeline = useCallback(() => {
    onAddToTimeline?.(entry);
    onClose();
  }, [entry, onAddToTimeline, onClose]);

  const handleTranscribe = useCallback(() => {
    if (isTranscribing) {
      return;
    }

    onTranscribe?.(entry);
    onClose();
  }, [entry, isTranscribing, onClose, onTranscribe]);

  const canTranscribe =
    !entry.isDirectory &&
    entry.assetId != null &&
    (entry.kind === 'video' || entry.kind === 'audio');

  // Ensure menu stays within viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    left: position.x,
    top: position.y,
    zIndex: 50,
  };

  return (
    <div
      ref={menuRef}
      className="min-w-[180px] py-1 bg-surface-highest border border-editor-border rounded-md shadow-lg"
      style={style}
    >
      {/* Add to Timeline (media files only) */}
      {!entry.isDirectory && entry.assetId && (
        <button
          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-editor-text hover:bg-surface-active transition-colors"
          onClick={handleAddToTimeline}
        >
          <Plus className="w-3.5 h-3.5" />
          Add to Timeline
        </button>
      )}

      {/* Transcribe (audio/video assets only) */}
      {canTranscribe && (
        <button
          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-editor-text hover:bg-surface-active transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          onClick={handleTranscribe}
          disabled={isTranscribing}
        >
          {isTranscribing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <MessageSquare className="w-3.5 h-3.5" />
          )}
          {isTranscribing ? 'Transcribing...' : 'Transcribe'}
        </button>
      )}

      {(canTranscribe || (!entry.isDirectory && entry.assetId)) && (
        <div className="my-1 border-t border-editor-border" />
      )}

      {/* New Folder */}
      {entry.isDirectory && (
        <button
          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-editor-text hover:bg-surface-active transition-colors"
          onClick={handleCreateFolder}
        >
          <FolderPlus className="w-3.5 h-3.5" />
          New Folder
        </button>
      )}

      {/* Rename */}
      <button
        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-editor-text hover:bg-surface-active transition-colors"
        onClick={handleRename}
      >
        <Pencil className="w-3.5 h-3.5" />
        Rename
      </button>

      {/* Divider */}
      <div className="my-1 border-t border-editor-border" />

      {/* Copy Path */}
      <button
        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-editor-text hover:bg-surface-active transition-colors"
        onClick={handleCopyPath}
      >
        <Copy className="w-3.5 h-3.5" />
        Copy Path
      </button>

      {/* Reveal in Explorer */}
      <button
        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-editor-text hover:bg-surface-active transition-colors"
        onClick={handleReveal}
      >
        <ExternalLink className="w-3.5 h-3.5" />
        Reveal in File Explorer
      </button>

      {/* Divider */}
      <div className="my-1 border-t border-editor-border" />

      {/* Delete */}
      <button
        className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-red-400 hover:bg-surface-active transition-colors"
        onClick={handleDelete}
      >
        <Trash2 className="w-3.5 h-3.5" />
        Delete
      </button>
    </div>
  );
}
