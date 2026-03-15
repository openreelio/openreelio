/**
 * Source Monitor for previewing raw assets and marking In/Out points.
 * Part of the dual-viewer (Source/Program) NLE workflow.
 */

import {
  type FC,
  useCallback,
  useMemo,
  type KeyboardEvent,
  type DragEvent,
} from 'react';
import { Play, Pause } from 'lucide-react';
import { PreviewPlayer } from '@/components/preview';
import { SeekBar } from '@/components/preview';
import { useSourceMonitor } from '@/hooks/useSourceMonitor';
import { useProjectStore } from '@/stores';
import { convertFileSrc } from '@tauri-apps/api/core';
import { formatDuration } from '@/utils/formatters';

/** Custom MIME type for source-to-timeline drag */
const SOURCE_DRAG_TYPE = 'application/x-openreelio-source';

export interface SourceMonitorProps {
  /** Additional CSS classes */
  className?: string;
}

function isInputElement(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export const SourceMonitor: FC<SourceMonitorProps> = ({ className }) => {
  const {
    assetId,
    inPoint,
    outPoint,
    markedDuration,
    currentTime,
    isPlaying,
    duration,
    setInPoint,
    setOutPoint,
    clearInOut,
    seek,
    togglePlayback,
    setCurrentTime,
    setDuration,
    setIsPlaying,
  } = useSourceMonitor();

  const assets = useProjectStore((s) => s.assets);
  const asset = useMemo(
    () => (assetId ? assets.get(assetId) ?? null : null),
    [assetId, assets],
  );

  const src = useMemo(
    () => (asset ? convertFileSrc(asset.uri) : undefined),
    [asset],
  );

  // Keyboard: I = In, O = Out, Escape = clear, Space = play/pause
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (isInputElement(e.target)) return;
      const key = e.key.toLowerCase();

      if (key === 'i') {
        e.preventDefault();
        e.stopPropagation();
        void setInPoint();
      } else if (key === 'o') {
        e.preventDefault();
        e.stopPropagation();
        void setOutPoint();
      } else if (key === 'escape') {
        e.preventDefault();
        e.stopPropagation();
        void clearInOut();
      } else if (key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        togglePlayback();
      }
    },
    [setInPoint, setOutPoint, clearInOut, togglePlayback],
  );

  // Drag from source monitor to timeline
  const handleDragStart = useCallback(
    (e: DragEvent) => {
      if (!assetId) return;
      e.dataTransfer.setData(
        SOURCE_DRAG_TYPE,
        JSON.stringify({
          assetId,
          sourceIn: inPoint,
          sourceOut: outPoint,
        }),
      );
      e.dataTransfer.effectAllowed = 'copy';
    },
    [assetId, inPoint, outPoint],
  );

  // In/Out marker percentages
  const inPercent = inPoint !== null && duration > 0 ? (inPoint / duration) * 100 : null;
  const outPercent = outPoint !== null && duration > 0 ? (outPoint / duration) * 100 : null;

  // Empty state
  if (!asset) {
    return (
      <div
        className={`flex h-full items-center justify-center bg-editor-bg text-gray-500 ${className ?? ''}`}
      >
        <div className="text-center text-sm">
          <p>No source loaded</p>
          <p className="mt-1 text-xs text-gray-600">
            Click an asset in the Project Explorer
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex h-full flex-col bg-editor-bg ${className ?? ''}`}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-editor-border px-2 py-1">
        <span className="truncate text-xs text-gray-300" title={asset.name}>
          Source: {asset.name}
        </span>
        {markedDuration !== null && (
          <span className="text-xs text-cyan-400">
            {formatDuration(markedDuration)}
          </span>
        )}
      </div>

      {/* Video preview area (draggable to timeline) */}
      <div
        className="relative flex-1 cursor-grab overflow-hidden"
        draggable={!!assetId}
        onDragStart={handleDragStart}
      >
        <PreviewPlayer
          src={src}
          className="h-full w-full"
          showControls={false}
          playhead={currentTime}
          isPlaying={isPlaying}
          onPlayheadChange={setCurrentTime}
          onPlayStateChange={setIsPlaying}
          onDurationChange={setDuration}
        />
      </div>

      {/* Seek bar with In/Out marker overlays */}
      <div className="relative px-2 py-1">
        <SeekBar
          currentTime={currentTime}
          duration={duration}
          onSeek={seek}
        />
        {/* In/Out marker overlay */}
        {duration > 0 && (
          <div className="pointer-events-none absolute inset-x-2 bottom-1 top-1">
            {inPercent !== null && outPercent !== null && (
              <div
                className="absolute top-0 h-full bg-cyan-500/20"
                style={{
                  left: `${inPercent}%`,
                  width: `${outPercent - inPercent}%`,
                }}
              />
            )}
            {inPercent !== null && (
              <div
                className="absolute top-0 h-full w-0.5 bg-cyan-400"
                style={{ left: `${inPercent}%` }}
              >
                <div className="absolute -left-1 -top-3 text-[9px] font-bold text-cyan-400">
                  I
                </div>
              </div>
            )}
            {outPercent !== null && (
              <div
                className="absolute top-0 h-full w-0.5 bg-cyan-400"
                style={{ left: `${outPercent}%` }}
              >
                <div className="absolute -right-2 -top-3 text-[9px] font-bold text-cyan-400">
                  O
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Transport controls + timecode display */}
      <div className="flex items-center gap-2 border-t border-editor-border px-2 py-0.5">
        <button
          type="button"
          className="rounded p-0.5 text-gray-400 hover:text-white"
          onClick={togglePlayback}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <span className="text-[10px] text-gray-400">
          {formatDuration(currentTime)} / {formatDuration(duration)}
        </span>
        <div className="ml-auto flex gap-3 text-[10px]">
          {inPoint !== null && (
            <span className="text-cyan-400">IN {formatDuration(inPoint)}</span>
          )}
          {outPoint !== null && (
            <span className="text-cyan-400">OUT {formatDuration(outPoint)}</span>
          )}
        </div>
      </div>
    </div>
  );
};
