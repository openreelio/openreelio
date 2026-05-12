import { lazy, Suspense } from 'react';
import { Sliders } from 'lucide-react';
import type { AudioMixerPanelProps } from '@/components/features/mixer';
import { Timeline, type TimelineProps } from '@/components/timeline';
import { TimelineErrorBoundary } from '@/components/shared';
import type { Logger } from '@/services/logger';
import type { Sequence } from '@/types';

const BOTTOM_PANEL_LOADING_FALLBACK = (
  <div className="flex h-full items-center justify-center text-xs text-editor-text-muted">
    Loading panel...
  </div>
);

const AudioMixerPanelLazy = lazy(async () => {
  const module = await import('@/components/features/mixer');
  return { default: module.AudioMixerPanel };
});

interface EditorTimelineDockPanelProps {
  logger: Logger;
  sequence: Sequence | null;
  sequenceNavigationStack: string[];
  sequences: Map<string, Sequence>;
  onPopSequence: () => void;
  showMixer: boolean;
  onToggleMixer: () => void;
  timelineProps: TimelineProps;
  audioMixerProps: AudioMixerPanelProps;
}

export function EditorTimelineDockPanel({
  logger,
  sequence,
  sequenceNavigationStack,
  sequences,
  onPopSequence,
  showMixer,
  onToggleMixer,
  timelineProps,
  audioMixerProps,
}: EditorTimelineDockPanelProps): JSX.Element {
  return (
    <div className="h-full min-h-0 p-3">
      <section className="flex h-full flex-col overflow-hidden rounded-xl border border-editor-border bg-editor-panel">
        <div className="flex items-center justify-between border-b border-editor-border px-3 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-editor-text-muted">
            Timeline
          </h2>
          <button
            type="button"
            onClick={onToggleMixer}
            className={`rounded p-1 transition-colors ${
              showMixer
                ? 'bg-editor-border text-editor-text'
                : 'text-editor-text-muted hover:text-editor-text hover:bg-editor-border/50'
            }`}
            title={showMixer ? 'Hide Mixer' : 'Show Mixer'}
            aria-label={showMixer ? 'Hide Mixer' : 'Show Mixer'}
            aria-pressed={showMixer}
          >
            <Sliders className="h-3.5 w-3.5" />
          </button>
        </div>

        {sequenceNavigationStack.length > 0 && (
          <div className="flex items-center gap-1 border-b border-gray-700 bg-gray-800 px-3 py-1 text-xs text-gray-300">
            <button
              className="hover:text-white transition-colors"
              onClick={onPopSequence}
              title="Back to parent sequence"
            >
              &larr; Back
            </button>
            <span className="text-gray-500">/</span>
            {sequenceNavigationStack.map((seqId) => {
              const parentSequence = sequences.get(seqId);
              return (
                <span key={seqId} className="text-gray-400">
                  {parentSequence?.name ?? seqId}
                  <span className="mx-1 text-gray-500">/</span>
                </span>
              );
            })}
            <span className="font-medium text-white">{sequence?.name ?? 'Inner Sequence'}</span>
          </div>
        )}

        <div className="min-h-0 flex-1">
          <TimelineErrorBoundary onError={(error) => logger.error('Timeline error', { error })}>
            <Timeline {...timelineProps} />
          </TimelineErrorBoundary>
        </div>

        {showMixer && (
          <div
            className="shrink-0 border-t border-editor-border bg-editor-sidebar"
            style={{ height: '220px' }}
          >
            <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
              <AudioMixerPanelLazy {...audioMixerProps} compact className="h-full" />
            </Suspense>
          </div>
        )}
      </section>
    </div>
  );
}
