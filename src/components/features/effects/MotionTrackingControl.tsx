/**
 * MotionTrackingControl Component
 *
 * A control panel for motion tracking settings and track points.
 * Features:
 * - Tracking method selection (Point, Region, Planar)
 * - Track points list with keyframe info
 * - Add/remove track points
 * - Tracking settings panel
 * - Progress indicator during tracking
 *
 * @module components/features/effects/MotionTrackingControl
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Target, Plus, Trash2, Settings, Lock, Play, Square, ChevronDown } from 'lucide-react';
import type {
  MotionTrack,
  TrackPoint,
  TrackingMethod,
} from '@/utils/motionTracking';
import {
  ALL_TRACKING_METHODS,
  getTrackingMethodLabel,
  interpolateTrackData,
} from '@/utils/motionTracking';

// =============================================================================
// Types
// =============================================================================

export interface MotionTrackingControlProps {
  /** The motion track data */
  track: MotionTrack;
  /** Current playhead time in seconds */
  currentTime: number;
  /** Called when track data changes */
  onTrackChange: (track: MotionTrack) => void;
  /** Called when user wants to add a new point */
  onAddPoint: () => void;
  /** Called when user wants to remove a point */
  onRemovePoint: (pointId: string) => void;
  /** Called when user starts tracking */
  onStartTracking: () => void;
  /** Called when user stops tracking */
  onStopTracking?: () => void;
  /** Whether tracking is in progress */
  isTracking?: boolean;
  /** Tracking progress (0-1) */
  trackingProgress?: number;
  /** Whether the control is disabled */
  disabled?: boolean;
  /** Additional CSS class */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function MotionTrackingControl({
  track,
  currentTime,
  onTrackChange,
  onAddPoint,
  onRemovePoint,
  onStartTracking,
  onStopTracking,
  isTracking = false,
  trackingProgress = 0,
  disabled = false,
  className = '',
}: MotionTrackingControlProps) {
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null);
  const [isMethodOpen, setIsMethodOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const methodRef = useRef<HTMLDivElement>(null);

  const isLocked = track.locked;
  const isControlsDisabled = disabled || isTracking || isLocked;

  // Close method dropdown when clicking outside
  useEffect(() => {
    if (!isMethodOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        methodRef.current &&
        !methodRef.current.contains(event.target as Node)
      ) {
        setIsMethodOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMethodOpen]);

  // Handle method change
  const handleMethodChange = useCallback(
    (method: TrackingMethod) => {
      onTrackChange({
        ...track,
        settings: { ...track.settings, method },
      });
      setIsMethodOpen(false);
    },
    [track, onTrackChange]
  );

  // Handle settings change
  const handleSettingsChange = useCallback(
    (key: keyof typeof track.settings, value: number | boolean) => {
      onTrackChange({
        ...track,
        settings: { ...track.settings, [key]: value },
      });
    },
    [track, onTrackChange]
  );

  // Handle point selection
  const handlePointClick = useCallback((pointId: string) => {
    setSelectedPointId((prev) => (prev === pointId ? null : pointId));
  }, []);

  // Get confidence for a point at current time
  const getPointConfidence = useCallback(
    (point: TrackPoint): number => {
      if (point.keyframes.length === 0) return 0;
      const data = interpolateTrackData(point.keyframes, currentTime);
      return data?.confidence ?? 0;
    },
    [currentTime]
  );

  return (
    <div
      data-testid="motion-tracking-control"
      className={`flex flex-col gap-4 p-3 bg-zinc-800 rounded-lg ${disabled ? 'opacity-50' : ''} ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target size={16} className="text-zinc-400" />
          <h3 className="text-sm font-medium text-zinc-200">Motion Tracking</h3>
        </div>
        {isLocked && (
          <div data-testid="locked-indicator" className="flex items-center gap-1 text-zinc-500">
            <Lock size={12} />
            <span className="text-xs">Locked</span>
          </div>
        )}
      </div>

      {/* Method Selector */}
      <div className="space-y-1">
        <label className="text-xs text-zinc-400">Method</label>
        <div ref={methodRef} className="relative">
          <button
            type="button"
            data-testid="method-selector"
            onClick={() => !isControlsDisabled && setIsMethodOpen(!isMethodOpen)}
            disabled={isControlsDisabled}
            className={`
              flex items-center justify-between gap-2 w-full
              px-3 py-1.5 text-sm
              bg-zinc-700 border border-zinc-600 rounded
              text-zinc-200
              ${isControlsDisabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-zinc-600'}
              transition-colors
            `}
          >
            <span>{getTrackingMethodLabel(track.settings.method)}</span>
            <ChevronDown
              size={14}
              className={`transition-transform ${isMethodOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {isMethodOpen && (
            <div
              role="listbox"
              className="absolute z-50 mt-1 w-full bg-zinc-800 border border-zinc-600 rounded shadow-lg py-1"
            >
              {ALL_TRACKING_METHODS.map((method) => (
                <div
                  key={method}
                  role="option"
                  aria-selected={track.settings.method === method}
                  onClick={() => handleMethodChange(method)}
                  className={`
                    px-3 py-1.5 text-sm cursor-pointer
                    ${track.settings.method === method
                      ? 'bg-blue-600 text-white'
                      : 'text-zinc-200 hover:bg-zinc-700'}
                    transition-colors
                  `}
                >
                  {getTrackingMethodLabel(method)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Track Points List */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-zinc-400">Track Points</label>
          <button
            type="button"
            onClick={onAddPoint}
            disabled={isControlsDisabled}
            aria-label="Add Point"
            className={`
              flex items-center gap-1 px-2 py-1 text-xs
              bg-zinc-700 rounded hover:bg-zinc-600
              text-zinc-200 transition-colors
              disabled:opacity-50 disabled:cursor-not-allowed
            `}
          >
            <Plus size={12} />
            Add Point
          </button>
        </div>

        {track.points.length === 0 ? (
          <div className="text-xs text-zinc-500 text-center py-4">
            No track points. Click "Add Point" to create one.
          </div>
        ) : (
          <div role="list" className="space-y-1">
            {track.points.map((point) => {
              const confidence = getPointConfidence(point);
              const isSelected = selectedPointId === point.id;

              return (
                <div
                  key={point.id}
                  data-testid={`track-point-${point.id}`}
                  role="listitem"
                  onClick={() => handlePointClick(point.id)}
                  className={`
                    flex items-center justify-between p-2 rounded cursor-pointer
                    ${isSelected ? 'ring-2 ring-blue-500 bg-zinc-700' : 'bg-zinc-700/50 hover:bg-zinc-700'}
                    transition-all
                  `}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: point.color }}
                    />
                    <div>
                      <div className="text-xs text-zinc-200">{point.name}</div>
                      <div className="text-xs text-zinc-500">
                        {point.keyframes.length} keyframes
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Confidence Indicator */}
                    <div
                      data-testid="confidence-indicator"
                      className="w-2 h-2 rounded-full"
                      style={{
                        backgroundColor:
                          confidence > 0.8
                            ? '#22c55e'
                            : confidence > 0.5
                            ? '#eab308'
                            : '#ef4444',
                      }}
                      title={`Confidence: ${Math.round(confidence * 100)}%`}
                    />

                    {/* Delete Button */}
                    <button
                      type="button"
                      data-testid={`delete-point-${point.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemovePoint(point.id);
                      }}
                      disabled={isControlsDisabled}
                      className="p-1 rounded hover:bg-zinc-600 text-zinc-400 hover:text-red-400 disabled:opacity-50"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Tracking Controls */}
      <div className="space-y-2">
        {isTracking ? (
          <>
            <div
              data-testid="tracking-progress"
              className="w-full h-2 bg-zinc-700 rounded-full overflow-hidden"
            >
              <div
                className="h-full bg-blue-500 transition-all"
                style={{ width: `${trackingProgress * 100}%` }}
              />
            </div>
            <button
              type="button"
              onClick={onStopTracking}
              aria-label="Stop"
              className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-red-600 hover:bg-red-700 rounded text-sm text-white transition-colors"
            >
              <Square size={14} />
              Stop
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onStartTracking}
            disabled={isControlsDisabled || track.points.length === 0}
            aria-label="Track"
            className={`
              w-full flex items-center justify-center gap-2 px-3 py-2
              bg-blue-600 hover:bg-blue-700 rounded text-sm text-white
              transition-colors
              disabled:opacity-50 disabled:cursor-not-allowed
            `}
          >
            <Play size={14} />
            Track
          </button>
        )}
      </div>

      {/* Settings Panel */}
      <div className="border-t border-zinc-700 pt-2">
        <button
          type="button"
          onClick={() => setIsSettingsOpen(!isSettingsOpen)}
          aria-label="Settings"
          className="flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <Settings size={12} />
          Settings
          <ChevronDown
            size={12}
            className={`transition-transform ${isSettingsOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {isSettingsOpen && (
          <div className="mt-3 space-y-3">
            {/* Search Area Size */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label htmlFor="search-area" className="text-xs text-zinc-400">
                  Search Area
                </label>
                <span className="text-xs text-zinc-500">
                  {track.settings.searchAreaSize}px
                </span>
              </div>
              <input
                id="search-area"
                type="range"
                min="50"
                max="300"
                step="10"
                value={track.settings.searchAreaSize}
                onChange={(e) =>
                  handleSettingsChange('searchAreaSize', parseInt(e.target.value))
                }
                disabled={isControlsDisabled}
                aria-label="Search Area"
                className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-50"
              />
            </div>

            {/* Pattern Size */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label htmlFor="pattern-size" className="text-xs text-zinc-400">
                  Pattern Size
                </label>
                <span className="text-xs text-zinc-500">
                  {track.settings.patternSize}px
                </span>
              </div>
              <input
                id="pattern-size"
                type="range"
                min="10"
                max="100"
                step="5"
                value={track.settings.patternSize}
                onChange={(e) =>
                  handleSettingsChange('patternSize', parseInt(e.target.value))
                }
                disabled={isControlsDisabled}
                aria-label="Pattern Size"
                className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-50"
              />
            </div>

            {/* Confidence Threshold */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label htmlFor="confidence" className="text-xs text-zinc-400">
                  Min Confidence
                </label>
                <span className="text-xs text-zinc-500">
                  {Math.round(track.settings.confidenceThreshold * 100)}%
                </span>
              </div>
              <input
                id="confidence"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={track.settings.confidenceThreshold}
                onChange={(e) =>
                  handleSettingsChange(
                    'confidenceThreshold',
                    parseFloat(e.target.value)
                  )
                }
                disabled={isControlsDisabled}
                aria-label="Confidence Threshold"
                className="w-full h-2 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-50"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default MotionTrackingControl;
