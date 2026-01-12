/**
 * AssetItem Component
 *
 * Individual asset item display in the project explorer.
 */

import { useCallback, type DragEvent, type MouseEvent } from 'react';
import { Film, Music, Image as ImageIcon } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export type AssetKind = 'video' | 'audio' | 'image';

export interface Resolution {
  width: number;
  height: number;
}

export interface AssetData {
  id: string;
  name: string;
  kind: AssetKind;
  duration?: number;
  thumbnail?: string;
  resolution?: Resolution;
  fileSize?: number;
}

export interface AssetItemProps {
  /** Asset data */
  asset: AssetData;
  /** Whether item is selected */
  isSelected?: boolean;
  /** Click handler */
  onClick?: (asset: AssetData) => void;
  /** Double click handler */
  onDoubleClick?: (asset: AssetData) => void;
  /** Context menu handler */
  onContextMenu?: (event: MouseEvent, asset: AssetData) => void;
  /** Drag start handler */
  onDragStart?: (asset: AssetData) => void;
}

// =============================================================================
// Utilities
// =============================================================================

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) {
    return '0:00';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatResolution(resolution: Resolution): string {
  return `${resolution.width}x${resolution.height}`;
}

function formatFileSize(bytes: number): string {
  if (!isFinite(bytes) || bytes < 0) {
    return '0 B';
  }

  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;

  if (bytes >= GB) {
    return `${(bytes / GB).toFixed(1)} GB`;
  }

  if (bytes >= MB) {
    return `${(bytes / MB).toFixed(1)} MB`;
  }

  if (bytes >= KB) {
    return `${Math.round(bytes / KB)} KB`;
  }

  return `${bytes} B`;
}

// =============================================================================
// Component
// =============================================================================

export function AssetItem({
  asset,
  isSelected = false,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
}: AssetItemProps) {
  // ===========================================================================
  // Handlers
  // ===========================================================================

  const handleClick = useCallback(() => {
    onClick?.(asset);
  }, [asset, onClick]);

  const handleDoubleClick = useCallback(() => {
    onDoubleClick?.(asset);
  }, [asset, onDoubleClick]);

  const handleContextMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      onContextMenu?.(e, asset);
    },
    [asset, onContextMenu]
  );

  const handleDragStart = useCallback(
    (e: DragEvent) => {
      if (e.dataTransfer) {
        e.dataTransfer.setData('application/json', JSON.stringify(asset));
        e.dataTransfer.effectAllowed = 'copy';
      }
      onDragStart?.(asset);
    },
    [asset, onDragStart]
  );

  // ===========================================================================
  // Icon Selection
  // ===========================================================================

  const renderIcon = () => {
    switch (asset.kind) {
      case 'video':
        return <Film data-testid="asset-icon-video" className="w-4 h-4" />;
      case 'audio':
        return <Music data-testid="asset-icon-audio" className="w-4 h-4" />;
      case 'image':
        return <ImageIcon data-testid="asset-icon-image" className="w-4 h-4" />;
      default:
        return <Film className="w-4 h-4" />;
    }
  };

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      data-testid="asset-item"
      role="button"
      tabIndex={0}
      draggable="true"
      aria-label={asset.name}
      aria-selected={isSelected}
      className={`
        flex items-center gap-2 p-2 rounded cursor-pointer select-none
        hover:bg-gray-700/50 transition-colors
        ${isSelected ? 'bg-primary-500/20 ring-1 ring-primary-500/50' : ''}
      `}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onDragStart={handleDragStart}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
    >
      {/* Thumbnail or Icon */}
      {asset.thumbnail ? (
        <div className="w-10 h-10 rounded overflow-hidden flex-shrink-0">
          <img
            data-testid="asset-thumbnail"
            src={asset.thumbnail}
            alt=""
            className="w-full h-full object-cover"
          />
        </div>
      ) : (
        <div className="w-10 h-10 rounded bg-gray-700 flex items-center justify-center flex-shrink-0">
          {renderIcon()}
        </div>
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-white truncate">{asset.name}</div>
        {/* Metadata Row */}
        {(asset.duration !== undefined || asset.resolution || asset.fileSize !== undefined) && (
          <div data-testid="asset-metadata" className="flex items-center gap-1 text-xs text-gray-400 flex-wrap">
            {asset.duration !== undefined && (
              <span data-testid="asset-duration">{formatDuration(asset.duration)}</span>
            )}
            {asset.resolution && asset.kind !== 'audio' && (
              <>
                {asset.duration !== undefined && <span className="text-gray-600">·</span>}
                <span data-testid="asset-resolution">{formatResolution(asset.resolution)}</span>
              </>
            )}
            {asset.fileSize !== undefined && (
              <>
                {(asset.duration !== undefined || (asset.resolution && asset.kind !== 'audio')) && (
                  <span className="text-gray-600">·</span>
                )}
                <span data-testid="asset-filesize">{formatFileSize(asset.fileSize)}</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
