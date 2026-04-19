import { lazy, Suspense, type ReactNode, type RefObject } from 'react';
import { Camera, Sliders } from 'lucide-react';
import { AISidebar, type AISidebarProps } from '@/components/features/ai';
import type { AudioMixerPanelProps } from '@/components/features/mixer';
import { Inspector, type InspectorProps } from '@/components/features/inspector';
import { ProjectExplorer } from '@/components/explorer';
import { UnifiedPreviewPlayer } from '@/components/preview';
import { SourceMonitor } from '@/components/features/preview/SourceMonitor';
import { Timeline, type TimelineProps } from '@/components/timeline';
import {
  AIErrorBoundary,
  ExplorerErrorBoundary,
  InspectorErrorBoundary,
  PreviewErrorBoundary,
  TimelineErrorBoundary,
} from '@/components/shared';
import { type Logger } from '@/services/logger';
import type { Sequence } from '@/types';
import type { PanelId } from '@/stores/workspaceLayoutStore';

const BOTTOM_PANEL_LOADING_FALLBACK = (
  <div className="flex h-full items-center justify-center text-xs text-editor-text-muted">
    Loading panel...
  </div>
);

const AudioMixerPanelLazy = lazy(async () => {
  const module = await import('@/components/features/mixer');
  return { default: module.AudioMixerPanel };
});

const VideoGenerationPanelLazy = lazy(async () => {
  const module = await import('@/components/features/generation');
  return { default: module.VideoGenerationPanel };
});

const ReferenceComparisonPanelLazy = lazy(async () => {
  const module = await import('@/components/features/comparison/ReferenceComparisonPanel');
  return { default: module.ReferenceComparisonPanel };
});

const AgentArtifactReviewPanelLazy = lazy(async () => {
  const module = await import('@/components/features/agent/AgentArtifactReviewPanel');
  return { default: module.AgentArtifactReviewPanel };
});

const UndoHistoryPanelLazy = lazy(async () => {
  const module = await import('@/components/features/history');
  return { default: module.UndoHistoryPanel };
});

const TranscriptEditorPanelLazy = lazy(async () => {
  const module = await import('@/components/features/transcript');
  return { default: module.TranscriptEditor };
});

const PerformancePanelLazy = lazy(async () => {
  const module = await import('@/components/features/dev');
  return { default: module.PerformancePanel };
});

const TerminalPanelLazy = lazy(async () => {
  const module = await import('@/components/features/terminal');
  return { default: module.TerminalPanel };
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

function EditorTimelineDockPanel({
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

export interface EditorPanelContentOptions {
  logger: Logger;
  sequence: Sequence | null;
  previewContainerRef: RefObject<HTMLDivElement>;
  isFullscreen: boolean;
  onCaptureSnapshot: () => void | Promise<void>;
  showMixer: boolean;
  onToggleMixer: () => void;
  sequenceNavigationStack: string[];
  sequences: Map<string, Sequence>;
  onPopSequence: () => void;
  timelineProps: TimelineProps;
  inspectorProps: InspectorProps;
  audioMixerProps: AudioMixerPanelProps;
  aiSidebarProps: AISidebarProps;
  videoGenerationEnabled: boolean;
}

export function createEditorPanelContent({
  logger,
  sequence,
  previewContainerRef,
  isFullscreen,
  onCaptureSnapshot,
  showMixer,
  onToggleMixer,
  sequenceNavigationStack,
  sequences,
  onPopSequence,
  timelineProps,
  inspectorProps,
  audioMixerProps,
  aiSidebarProps,
  videoGenerationEnabled,
}: EditorPanelContentOptions): Partial<Record<PanelId, ReactNode>> {
  return {
    explorer: (
      <ExplorerErrorBoundary onError={(error) => logger.error('ProjectExplorer error', { error })}>
        <div className="h-full overflow-auto p-4">
          <ProjectExplorer />
        </div>
      </ExplorerErrorBoundary>
    ),

    'source-monitor': (
      <PreviewErrorBoundary onError={(error) => logger.error('SourceMonitor error', { error })}>
        <SourceMonitor className="h-full w-full" />
      </PreviewErrorBoundary>
    ),

    'program-monitor': (
      <div
        ref={previewContainerRef as RefObject<HTMLDivElement>}
        className={`relative h-full w-full ${isFullscreen ? 'bg-black' : ''}`}
      >
        <PreviewErrorBoundary
          onError={(error) => logger.error('UnifiedPreviewPlayer error', { error })}
        >
          <UnifiedPreviewPlayer
            className="h-full w-full"
            showControls
            showTimecode
            showStats={import.meta.env.DEV}
          />
        </PreviewErrorBoundary>
        <button
          type="button"
          data-testid="snapshot-button"
          className="absolute top-2 right-2 z-10 rounded bg-black/40 p-1.5 text-white/70 transition-colors hover:bg-black/60 hover:text-white"
          onClick={onCaptureSnapshot}
          title="Capture Snapshot (Ctrl+Shift+S)"
          aria-label="Capture preview snapshot"
        >
          <Camera className="w-4 h-4" />
        </button>
      </div>
    ),

    timeline: (
      <EditorTimelineDockPanel
        logger={logger}
        sequence={sequence}
        sequenceNavigationStack={sequenceNavigationStack}
        sequences={sequences}
        onPopSequence={onPopSequence}
        showMixer={showMixer}
        onToggleMixer={onToggleMixer}
        timelineProps={timelineProps}
        audioMixerProps={audioMixerProps}
      />
    ),

    terminal: (
      <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
        <TerminalPanelLazy />
      </Suspense>
    ),

    inspector: (
      <InspectorErrorBoundary onError={(error) => logger.error('Inspector error', { error })}>
        <div className="h-full overflow-auto p-4">
          <Inspector {...inspectorProps} />
        </div>
      </InspectorErrorBoundary>
    ),

    'audio-mixer': (
      <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
        <AudioMixerPanelLazy {...audioMixerProps} className="h-full" />
      </Suspense>
    ),

    'ai-assistant': (
      <AIErrorBoundary onError={(error) => logger.error('AISidebar error', { error })}>
        <AISidebar {...aiSidebarProps} />
      </AIErrorBoundary>
    ),

    comparison: (
      <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
        <ReferenceComparisonPanelLazy />
      </Suspense>
    ),

    'agent-review': (
      <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
        <AgentArtifactReviewPanelLazy />
      </Suspense>
    ),

    history: (
      <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
        <UndoHistoryPanelLazy />
      </Suspense>
    ),

    transcript: (
      <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
        <TranscriptEditorPanelLazy />
      </Suspense>
    ),

    generation: videoGenerationEnabled ? (
      <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
        <VideoGenerationPanelLazy compact className="h-full" />
      </Suspense>
    ) : undefined,

    performance: (
      <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
        <PerformancePanelLazy />
      </Suspense>
    ),
  };
}
