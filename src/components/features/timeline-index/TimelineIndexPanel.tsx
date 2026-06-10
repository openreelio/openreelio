import { useMemo, useState } from 'react';
import { usePlaybackStore, useProjectStore, useTimelineStore } from '@/stores';
import { getClipTimelineEndSec } from '@/utils/clipTiming';
import {
  createTextClipData,
  EFFECT_TYPE_LABELS,
  isTextClip,
  type Clip,
  type Sequence,
} from '@/types';

type TimelineIndexKind = 'clip' | 'marker' | 'caption' | 'effect' | 'missing' | 'disabled';

interface TimelineIndexItem {
  id: string;
  kind: TimelineIndexKind;
  label: string;
  detail: string;
  timeSec: number;
  clipId?: string;
  trackId?: string;
}

export interface TimelineIndexPanelProps {
  sequence: Sequence | null;
}

const KIND_LABELS: Record<TimelineIndexKind, string> = {
  clip: 'Clips',
  marker: 'Markers',
  caption: 'Captions',
  effect: 'Effects',
  missing: 'Missing',
  disabled: 'Disabled',
};

const KIND_ORDER: TimelineIndexKind[] = [
  'clip',
  'marker',
  'caption',
  'effect',
  'missing',
  'disabled',
];

function formatTime(timeSec: number): string {
  const safeTime = Number.isFinite(timeSec) ? Math.max(0, timeSec) : 0;
  const totalSeconds = Math.floor(safeTime);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const frame = Math.floor((safeTime - totalSeconds) * 100);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(frame).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(frame).padStart(2, '0')}`;
}

function getClipLabel(clip: Clip, assetName?: string): string {
  if (clip.label?.trim()) return clip.label.trim();
  if (assetName?.trim()) return assetName.trim();
  if (isTextClip(clip.assetId)) {
    return createTextClipData(clip.assetId)?.content || 'Text Clip';
  }
  return clip.assetId;
}

function getEffectLabel(effectType: unknown): string {
  if (typeof effectType === 'object' && effectType !== null && 'custom' in effectType) {
    const customType = (effectType as { custom?: unknown }).custom;
    return typeof customType === 'string' && customType.trim() ? customType.trim() : 'Custom';
  }
  if (typeof effectType !== 'string') return 'Effect';
  return EFFECT_TYPE_LABELS[effectType as keyof typeof EFFECT_TYPE_LABELS] ?? effectType;
}

function buildTimelineIndexItems(
  sequence: Sequence,
  assets: ReturnType<typeof useProjectStore.getState>['assets'],
  effects: ReturnType<typeof useProjectStore.getState>['effects'],
): TimelineIndexItem[] {
  const items: TimelineIndexItem[] = [];

  for (const marker of sequence.markers) {
    items.push({
      id: `marker:${marker.id}`,
      kind: 'marker',
      label: marker.label || marker.markerType,
      detail: marker.markerType,
      timeSec: marker.timeSec,
    });
  }

  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      const asset = assets.get(clip.assetId);
      const label =
        track.kind === 'caption' ? clip.label || 'Caption' : getClipLabel(clip, asset?.name);
      const timeSec = clip.place.timelineInSec;
      const duration = Math.max(0, getClipTimelineEndSec(clip) - timeSec);
      const baseDetail = `${track.name} | ${formatTime(duration)}`;
      const isMissingAsset = track.kind !== 'caption' && !isTextClip(clip.assetId) && !asset;

      items.push({
        id: `clip:${track.id}:${clip.id}`,
        kind: track.kind === 'caption' ? 'caption' : 'clip',
        label,
        detail: baseDetail,
        timeSec,
        clipId: clip.id,
        trackId: track.id,
      });

      if (clip.enabled === false) {
        items.push({
          id: `disabled:${track.id}:${clip.id}`,
          kind: 'disabled',
          label,
          detail: baseDetail,
          timeSec,
          clipId: clip.id,
          trackId: track.id,
        });
      }

      if (isMissingAsset) {
        items.push({
          id: `missing:${track.id}:${clip.id}`,
          kind: 'missing',
          label,
          detail: `${baseDetail} | ${clip.assetId}`,
          timeSec,
          clipId: clip.id,
          trackId: track.id,
        });
      }

      for (const effectId of clip.effects) {
        const effect = effects.get(effectId);
        if (!effect) continue;
        items.push({
          id: `effect:${track.id}:${clip.id}:${effectId}`,
          kind: 'effect',
          label: getEffectLabel(effect.effectType),
          detail: `${label} | ${track.name}`,
          timeSec,
          clipId: clip.id,
          trackId: track.id,
        });
      }
    }
  }

  return items.sort((a, b) => a.timeSec - b.timeSec || a.label.localeCompare(b.label));
}

export function TimelineIndexPanel({ sequence }: TimelineIndexPanelProps): JSX.Element {
  const assets = useProjectStore((state) => state.assets);
  const effects = useProjectStore((state) => state.effects);
  const seek = usePlaybackStore((state) => state.seek);
  const selectClip = useTimelineStore((state) => state.selectClip);
  const [query, setQuery] = useState('');
  const [activeKind, setActiveKind] = useState<TimelineIndexKind | 'all'>('all');

  const items = useMemo(
    () => (sequence ? buildTimelineIndexItems(sequence, assets, effects) : []),
    [assets, effects, sequence],
  );

  const counts = useMemo(() => {
    const next: Record<TimelineIndexKind, number> = {
      clip: 0,
      marker: 0,
      caption: 0,
      effect: 0,
      missing: 0,
      disabled: 0,
    };
    for (const item of items) next[item.kind] += 1;
    return next;
  }, [items]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items.filter((item) => {
      if (activeKind !== 'all' && item.kind !== activeKind) return false;
      if (!normalizedQuery) return true;
      return `${item.label} ${item.detail} ${item.kind}`.toLowerCase().includes(normalizedQuery);
    });
  }, [activeKind, items, query]);

  const handleItemClick = (item: TimelineIndexItem) => {
    seek(item.timeSec, 'timeline-index');
    if (item.clipId) {
      selectClip(item.clipId);
    }
  };

  return (
    <div
      className="flex h-full flex-col bg-editor-bg text-editor-text"
      data-testid="timeline-index-panel"
    >
      <div className="flex items-center gap-2 border-b border-editor-border p-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search timeline"
          className="h-8 min-w-0 flex-1 rounded border border-editor-border bg-editor-surface px-2 text-sm text-editor-text outline-none focus:border-primary-500"
          aria-label="Search timeline index"
        />
        <select
          value={activeKind}
          onChange={(event) => setActiveKind(event.target.value as TimelineIndexKind | 'all')}
          className="h-8 rounded border border-editor-border bg-editor-surface px-2 text-sm text-editor-text outline-none focus:border-primary-500"
          aria-label="Timeline index filter"
        >
          <option value="all">All</option>
          {KIND_ORDER.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]} ({counts[kind]})
            </option>
          ))}
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {filteredItems.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-editor-text-muted">
            No timeline items
          </div>
        ) : (
          <div className="divide-y divide-editor-border/70">
            {filteredItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleItemClick(item)}
                className="grid w-full grid-cols-[72px_96px_minmax(0,1fr)] items-center gap-2 px-3 py-2 text-left text-sm hover:bg-editor-hover focus:bg-editor-hover focus:outline-none"
              >
                <span className="font-mono text-xs text-editor-text-muted">
                  {formatTime(item.timeSec)}
                </span>
                <span className="rounded bg-editor-surface px-2 py-0.5 text-xs text-editor-text-muted">
                  {KIND_LABELS[item.kind]}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-editor-text">{item.label}</span>
                  <span className="block truncate text-xs text-editor-text-muted">
                    {item.detail}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
