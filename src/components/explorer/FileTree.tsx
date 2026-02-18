/**
 * FileTree Component
 *
 * VS Code-like file tree for the workspace explorer.
 * Shows all media files in the project folder with registration status.
 */

import { useCallback, type MouseEvent } from 'react';
import { FolderSearch, RefreshCw } from 'lucide-react';
import type { FileTreeEntry } from '@/types';
import { FileTreeItem } from './FileTreeItem';

// =============================================================================
// Types
// =============================================================================

export interface FileTreeProps {
  /** Hierarchical file tree entries */
  entries: FileTreeEntry[];
  /** Whether a scan is in progress */
  isScanning?: boolean;
  /** Registration in-flight counters keyed by relative path */
  registeringPathCounts?: Record<string, number>;
  /** Handler for scanning the workspace */
  onScan?: () => void;
  /** Handler for clicking a file */
  onFileClick?: (entry: FileTreeEntry) => void;
  /** Handler for double-clicking a file (e.g., register + add to timeline) */
  onFileDoubleClick?: (entry: FileTreeEntry) => void;
  /** Handler for right-clicking a file */
  onContextMenu?: (event: MouseEvent, entry: FileTreeEntry) => void;
  /** Handler for starting a drag from a file */
  onDragStart?: (entry: FileTreeEntry) => void;
}

// =============================================================================
// Component
// =============================================================================

export function FileTree({
  entries,
  isScanning = false,
  registeringPathCounts,
  onScan,
  onFileClick,
  onFileDoubleClick,
  onContextMenu,
  onDragStart,
}: FileTreeProps) {
  const handleScan = useCallback(() => {
    onScan?.();
  }, [onScan]);

  if (entries.length === 0 && !isScanning) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-secondary gap-3">
        <FolderSearch className="w-12 h-12 opacity-50" />
        <p className="text-sm">No media files found</p>
        <button
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary-600 hover:bg-primary-500 text-white rounded transition-colors"
          onClick={handleScan}
        >
          <RefreshCw className="w-3 h-3" />
          Scan workspace
        </button>
      </div>
    );
  }

  return (
    <div className="text-sm">
      {isScanning && (
        <div className="flex items-center gap-2 p-2 text-xs text-text-secondary">
          <div className="w-3 h-3 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
          Scanning workspace...
        </div>
      )}
      {entries.map((entry) => (
        <FileTreeItem
          key={entry.relativePath}
          entry={entry}
          registeringPathCounts={registeringPathCounts}
          onFileClick={onFileClick}
          onFileDoubleClick={onFileDoubleClick}
          onContextMenu={onContextMenu}
          onDragStart={onDragStart}
        />
      ))}
    </div>
  );
}
