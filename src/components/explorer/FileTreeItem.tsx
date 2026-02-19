/**
 * FileTreeItem Component
 *
 * Individual file or folder item in the workspace file tree.
 * Supports expand/collapse for directories and drag for files.
 * All media files are draggable (auto-registered as assets by the backend).
 */

import { useState, useCallback, type DragEvent, type MouseEvent } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  Film,
  Music,
  Image as ImageIcon,
  FileText,
  File,
  AlertTriangle,
} from 'lucide-react';
import type { FileTreeEntry, AssetKind } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface FileTreeItemProps {
  /** File tree entry data */
  entry: FileTreeEntry;
  /** Nesting depth for indentation */
  depth?: number;
  /** Handler for clicking a file */
  onFileClick?: (entry: FileTreeEntry) => void;
  /** Handler for double-clicking a file (e.g., add to timeline) */
  onFileDoubleClick?: (entry: FileTreeEntry) => void;
  /** Handler for right-clicking a file */
  onContextMenu?: (event: MouseEvent, entry: FileTreeEntry) => void;
  /** Handler for starting a drag from a file */
  onDragStart?: (entry: FileTreeEntry) => void;
}

// =============================================================================
// Utilities
// =============================================================================

function getFileIcon(kind?: AssetKind) {
  switch (kind) {
    case 'video':
      return <Film className="w-4 h-4 text-blue-400" />;
    case 'audio':
      return <Music className="w-4 h-4 text-green-400" />;
    case 'image':
      return <ImageIcon className="w-4 h-4 text-purple-400" />;
    case 'subtitle':
      return <FileText className="w-4 h-4 text-yellow-400" />;
    default:
      return <File className="w-4 h-4 text-text-secondary" />;
  }
}

function formatFileSize(bytes?: number): string {
  if (bytes == null || bytes === 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// =============================================================================
// Component
// =============================================================================

export function FileTreeItem({
  entry,
  depth = 0,
  onFileClick,
  onFileDoubleClick,
  onContextMenu,
  onDragStart,
}: FileTreeItemProps) {
  const [isExpanded, setIsExpanded] = useState(depth < 1);

  const handleToggle = useCallback(() => {
    if (entry.isDirectory) {
      setIsExpanded((prev) => !prev);
    }
  }, [entry.isDirectory]);

  const handleClick = useCallback(() => {
    if (entry.isDirectory) {
      setIsExpanded((prev) => !prev);
    } else {
      onFileClick?.(entry);
    }
  }, [entry, onFileClick]);

  const handleDoubleClick = useCallback(() => {
    if (!entry.isDirectory) {
      onFileDoubleClick?.(entry);
    }
  }, [entry, onFileDoubleClick]);

  const handleContextMenu = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      onContextMenu?.(event, entry);
    },
    [entry, onContextMenu],
  );

  const handleDragStart = useCallback(
    (event: DragEvent) => {
      if (entry.isDirectory) {
        event.preventDefault();
        return;
      }

      const payload = {
        ...(entry.assetId != null ? { assetId: entry.assetId } : {}),
        ...(entry.kind != null ? { kind: entry.kind } : {}),
        workspaceRelativePath: entry.relativePath,
      };

      event.dataTransfer.setData('application/x-workspace-file', entry.relativePath);
      event.dataTransfer.setData('application/json', JSON.stringify(payload));
      event.dataTransfer.setData('text/plain', entry.assetId ?? entry.relativePath);
      event.dataTransfer.effectAllowed = 'copy';
      onDragStart?.(entry);
    },
    [entry, onDragStart],
  );

  const paddingLeft = 8 + depth * 16;

  return (
    <>
      <div
        className={`flex items-center gap-1.5 py-0.5 text-sm cursor-pointer hover:bg-surface-active transition-colors group ${
          entry.missing ? 'opacity-50' : ''
        }`}
        style={{ paddingLeft }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        draggable={!entry.isDirectory}
        onDragStart={handleDragStart}
        title={entry.relativePath}
      >
        {/* Expand/collapse toggle for directories */}
        {entry.isDirectory ? (
          <button
            className="p-0.5 flex-shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              handleToggle();
            }}
          >
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-text-secondary" />
            ) : (
              <ChevronRight className="w-3 h-3 text-text-secondary" />
            )}
          </button>
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}

        {/* Icon */}
        {entry.isDirectory ? (
          <Folder className="w-4 h-4 text-yellow-500 flex-shrink-0" />
        ) : (
          getFileIcon(entry.kind)
        )}

        {/* Name */}
        <span className="truncate flex-1 text-editor-text">{entry.name}</span>

        {/* Missing file indicator */}
        {!entry.isDirectory && entry.missing && (
          <span title="File not found — may have been moved or deleted">
            <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
          </span>
        )}

        {/* File size badge */}
        {!entry.isDirectory && entry.fileSize != null && (
          <span className="text-[10px] text-text-muted flex-shrink-0 mr-2">
            {formatFileSize(entry.fileSize)}
          </span>
        )}
      </div>

      {/* Render children if expanded */}
      {entry.isDirectory && isExpanded && entry.children.length > 0 && (
        <div>
          {entry.children.map((child) => (
            <FileTreeItem
              key={child.relativePath}
              entry={child}
              depth={depth + 1}
              onFileClick={onFileClick}
              onFileDoubleClick={onFileDoubleClick}
              onContextMenu={onContextMenu}
              onDragStart={onDragStart}
            />
          ))}
        </div>
      )}
    </>
  );
}
