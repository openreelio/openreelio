/**
 * Source Monitor for previewing raw assets and marking In/Out points.
 * Part of the dual-viewer (Source/Program) NLE workflow.
 * Supports J/K/L shuttle control for transport navigation.
 */

import {
  type FC,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type DragEvent,
} from 'react';
import { Play, Pause } from 'lucide-react';
import { PreviewPlayer } from '@/components/preview';
import { SeekBar } from '@/components/preview';
import { ShuttleSpeedIndicator } from '@/components/preview/ShuttleSpeedIndicator';
import { useSourceMonitor } from '@/hooks/useSourceMonitor';
import { useJKLShuttle } from '@/hooks/useJKLShuttle';
import { useProjectStore } from '@/stores';
import { useEditorToolStore } from '@/stores/editorToolStore';
import { convertFileSrc } from '@tauri-apps/api/core';
import { formatDuration, formatTimecode } from '@/utils/formatters';
import { TimecodeInput } from './TimecodeInput';
import { PLAYBACK } from '@/constants/preview';
import { isInputElement } from '@/utils/dom';

/** Custom MIME type for source-to-timeline drag */
const SOURCE_DRAG_TYPE = 'application/x-openreelio-source';

/** Frame duration for stepping at target FPS */
const FRAME_SEC = 1 / PLAYBACK.TARGET_FPS;

export interface SourceMonitorProps {
  /** Additional CSS classes */
  className?: string;
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

  const editMode = useEditorToolStore((s) => s.editMode);
  const assets = useProjectStore((s) => s.assets);
  const asset = useMemo(() => (assetId ? (assets.get(assetId) ?? null) : null), [assetId, assets]);

  const src = useMemo(() => (asset ? convertFileSrc(asset.uri) : undefined), [asset]);
  const [playbackRate, setPlaybackRate] = useState(1);

  useEffect(() => {
    setPlaybackRate(1);
  }, [assetId]);

  // Refs for values that change frequently (avoid stale closures in shuttle callbacks)
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  // JKL Shuttle control for source monitor
  const shuttle = useJKLShuttle({
    play: () => setIsPlaying(true),
    pause: () => setIsPlaying(false),
    setPlaybackRate,
    stepForward: () => {
      const t = Math.min(durationRef.current, currentTimeRef.current + FRAME_SEC);
      seek(t);
    },
    stepBackward: () => {
      const t = Math.max(0, currentTimeRef.current - FRAME_SEC);
      seek(t);
    },
    seekRelative: (deltaSec: number) => {
      const t = Math.max(0, Math.min(durationRef.current, currentTimeRef.current + deltaSec));
      seek(t);
    },
    enabled: !!assetId,
  });

  const handleTransportToggle = useCallback(() => {
    togglePlayback();
    shuttle.resetShuttle();
  }, [togglePlayback, shuttle]);

  // Keyboard: I = In, O = Out, Escape = clear, Space = play/pause, J/K/L = shuttle
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (isInputElement(e.target)) return;

      const { key, ctrlKey, metaKey, shiftKey } = e;
      const ctrl = ctrlKey || metaKey;

      // J/K/L shuttle — delegate to hook
      if (shuttle.handleKeyDown(key, ctrl, shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const lowerKey = key.toLowerCase();

      if (lowerKey === 'i' && !ctrl) {
        e.preventDefault();
        e.stopPropagation();
        void setInPoint();
      } else if (lowerKey === 'o' && !ctrl) {
        e.preventDefault();
        e.stopPropagation();
        void setOutPoint();
      } else if (key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        void clearInOut();
      } else if (key === ' ' && !ctrl) {
        e.preventDefault();
        e.stopPropagation();
        handleTransportToggle();
      }
    },
    [setInPoint, setOutPoint, clearInOut, handleTransportToggle, shuttle],
  );

  // Keyup handler for K+J/K+L combo detection
  const handleKeyUp = useCallback(
    (e: KeyboardEvent) => {
      if (isInputElement(e.target)) return;
      shuttle.handleKeyUp(e.key);
    },
    [shuttle],
  );

  // Drag from source monitor to timeline
  const handleDragStart = useCallback(
    (e: DragEvent) => {
      if (!assetId) return;
      e.dataTransfer.setData(
        SOURCE_DRAG_TYPE,
        JSON.stringify({
          assetId,
          editMode,
          sourceIn: inPoint,
          sourceOut: outPoint,
        }),
      );
      e.dataTransfer.effectAllowed = 'copy';
    },
    [assetId, editMode, inPoint, outPoint],
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
          <p className="mt-1 text-xs text-gray-600">Click an asset in the Project Explorer</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex h-full flex-col bg-editor-bg ${className ?? ''}`}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      tabIndex={0}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-editor-border px-2 py-1">
        <span className="truncate text-xs text-gray-300" title={asset.name}>
          Source: {asset.name}
        </span>
        {markedDuration !== null && (
          <span className="text-xs text-cyan-400">{formatDuration(markedDuration)}</span>
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
          playbackRate={playbackRate}
          onPlayheadChange={setCurrentTime}
          onPlayStateChange={setIsPlaying}
          onDurationChange={setDuration}
        />
        {/* Shuttle speed overlay on video area */}
        <ShuttleSpeedIndicator shuttleSpeed={shuttle.shuttleSpeed} />
      </div>

      {/* Seek bar with In/Out marker overlays */}
      <div className="relative px-2 py-1">
        <SeekBar currentTime={currentTime} duration={duration} onSeek={seek} />
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
                <div className="absolute -left-1 -top-3 text-[9px] font-bold text-cyan-400">I</div>
              </div>
            )}
            {outPercent !== null && (
              <div
                className="absolute top-0 h-full w-0.5 bg-cyan-400"
                style={{ left: `${outPercent}%` }}
              >
                <div className="absolute -right-2 -top-3 text-[9px] font-bold text-cyan-400">O</div>
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
          onClick={handleTransportToggle}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <div className="flex items-center gap-1 text-[10px]">
          <TimecodeInput currentTime={currentTime} duration={duration} onSeek={seek} />
          <span className="text-gray-500">/</span>
          <span className="text-gray-500">{formatTimecode(duration, PLAYBACK.TARGET_FPS)}</span>
        </div>
        <div className="ml-auto flex gap-3 text-[10px]">
          {inPoint !== null && <span className="text-cyan-400">IN {formatDuration(inPoint)}</span>}
          {outPoint !== null && (
            <span className="text-cyan-400">OUT {formatDuration(outPoint)}</span>
          )}
        </div>
      </div>
    </div>
  );
};
