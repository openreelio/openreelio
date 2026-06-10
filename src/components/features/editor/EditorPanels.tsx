import { lazy, Suspense, type ReactNode, type RefObject } from 'react';
import { Camera } from 'lucide-react';
import { AISidebar, type AISidebarProps } from '@/components/features/ai';
import type { AudioMixerPanelProps } from '@/components/features/mixer';
import { Inspector, type InspectorProps } from '@/components/features/inspector';
import { ProjectExplorer } from '@/components/explorer';
import { UnifiedPreviewPlayer } from '@/components/preview';
import { EffectsBrowser, type VisualEffectPreset } from '@/components/features/effects';
import type { TextPlacementCommitPayload } from '@/components/preview/TextPlacementOverlay';
import { SourceMonitor } from '@/components/features/preview/SourceMonitor';
import { MulticamAngleViewer } from '@/components/features/multicam';
import type { TimelineProps } from '@/components/timeline';
import {
  AIErrorBoundary,
  ExplorerErrorBoundary,
  InspectorErrorBoundary,
  PreviewErrorBoundary,
} from '@/components/shared';
import { type Logger } from '@/services/logger';
import type { EffectPreset, FileTreeEntry, Sequence } from '@/types';
import type { MulticamGroup } from '@/utils/multicam';
import type { PanelId } from '@/stores/workspaceLayoutStore';
import { EditorTimelineDockPanel } from './EditorTimelineDockPanel';

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

const TimelineIndexPanelLazy = lazy(async () => {
  const module = await import('@/components/features/timeline-index/TimelineIndexPanel');
  return { default: module.TimelineIndexPanel };
});

const PreviewScopesPanelLazy = lazy(async () => {
  const module = await import('@/components/features/scopes');
  return { default: module.PreviewScopesPanel };
});

const PerformancePanelLazy = lazy(async () => {
  const module = await import('@/components/features/dev');
  return { default: module.PerformancePanel };
});

const TerminalPanelLazy = lazy(async () => {
  const module = await import('@/components/features/terminal');
  return { default: module.TerminalPanel };
});

export interface EditorPanelContentOptions {
  logger: Logger;
  sequence: Sequence | null;
  previewContainerRef: RefObject<HTMLDivElement>;
  isFullscreen: boolean;
  onCaptureSnapshot: () => void | Promise<void>;
  textPlacementModeActive?: boolean;
  onTextPlacementCommit?: (payload: TextPlacementCommitPayload) => void | Promise<void>;
  multicamGroup?: MulticamGroup | null;
  multicamCurrentTimeSec?: number;
  multicamRecording?: boolean;
  onMulticamAngleSwitch?: (angleIndex: number) => void;
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
  onExplorerAssetAddToTimeline?: (entry: FileTreeEntry) => void | Promise<void>;
  onSourceInsertEdit?: () => void | Promise<void>;
  onSourceOverwriteEdit?: () => void | Promise<void>;
  onEffectSelect?: (effectType: string) => void | Promise<void>;
  onEffectPresetSelect?: (preset: VisualEffectPreset) => void | Promise<void>;
  onSavedEffectPresetSelect?: (preset: EffectPreset) => void | Promise<void>;
}

export function createEditorPanelContent({
  logger,
  sequence,
  previewContainerRef,
  isFullscreen,
  onCaptureSnapshot,
  textPlacementModeActive = false,
  onTextPlacementCommit,
  multicamGroup = null,
  multicamCurrentTimeSec = 0,
  multicamRecording = false,
  onMulticamAngleSwitch,
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
  onExplorerAssetAddToTimeline,
  onSourceInsertEdit,
  onSourceOverwriteEdit,
  onEffectSelect,
  onEffectPresetSelect,
  onSavedEffectPresetSelect,
}: EditorPanelContentOptions): Partial<Record<PanelId, ReactNode>> {
  return {
    explorer: (
      <ExplorerErrorBoundary onError={(error) => logger.error('ProjectExplorer error', { error })}>
        <div className="h-full overflow-auto p-4">
          <ProjectExplorer onAddToTimeline={onExplorerAssetAddToTimeline} />
        </div>
      </ExplorerErrorBoundary>
    ),

    'source-monitor': (
      <PreviewErrorBoundary onError={(error) => logger.error('SourceMonitor error', { error })}>
        <SourceMonitor
          className="h-full w-full"
          onInsertEdit={onSourceInsertEdit}
          onOverwriteEdit={onSourceOverwriteEdit}
        />
      </PreviewErrorBoundary>
    ),

    'effects-browser': (
      <InspectorErrorBoundary onError={(error) => logger.error('EffectsBrowser error', { error })}>
        <EffectsBrowser
          className="h-full"
          onEffectSelect={onEffectSelect}
          onPresetSelect={onEffectPresetSelect}
          onSavedPresetSelect={onSavedEffectPresetSelect}
        />
      </InspectorErrorBoundary>
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
            textPlacementModeActive={textPlacementModeActive}
            onTextPlacementCommit={onTextPlacementCommit}
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
        {multicamGroup && onMulticamAngleSwitch && (
          <div className="absolute bottom-2 left-2 right-2 z-10 h-36 rounded border border-editor-border bg-black/80 p-1 shadow-lg">
            <MulticamAngleViewer
              group={multicamGroup}
              currentTimeSec={multicamCurrentTimeSec}
              onAngleSwitch={onMulticamAngleSwitch}
              isRecording={multicamRecording}
              className="h-full w-full"
            />
          </div>
        )}
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
      <AIErrorBoundary onError={(error) => logger.error('Agent review panel error', { error })}>
        <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
          <AgentArtifactReviewPanelLazy />
        </Suspense>
      </AIErrorBoundary>
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

    'timeline-index': (
      <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
        <TimelineIndexPanelLazy sequence={sequence} />
      </Suspense>
    ),

    scopes: (
      <Suspense fallback={BOTTOM_PANEL_LOADING_FALLBACK}>
        <PreviewScopesPanelLazy />
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
