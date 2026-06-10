import { useMemo } from 'react';
import { useVideoScopes } from '@/hooks/useVideoScopes';
import { usePreviewStore } from '@/stores/previewStore';
import { VideoScopesPanel, type ScopeType } from './VideoScopesPanel';

export interface PreviewScopesPanelProps {
  initialScope?: ScopeType;
  autoUpdate?: boolean;
  className?: string;
}

export function PreviewScopesPanel({
  initialScope = 'waveform',
  autoUpdate = true,
  className = '',
}: PreviewScopesPanelProps) {
  const previewCanvas = usePreviewStore((state) => state.programPreviewCanvas);
  const canvasRef = useMemo(() => ({ current: previewCanvas }), [previewCanvas]);
  const scopes = useVideoScopes(canvasRef, {
    enabled: previewCanvas !== null,
    autoStart: autoUpdate,
    updateRate: 8,
    sampleRate: 2,
  });

  return (
    <div className={`h-full overflow-auto bg-editor-bg p-3 ${className}`}>
      <VideoScopesPanel
        analysis={scopes.analysis}
        initialScope={initialScope}
        width={360}
        height={220}
        isAnalyzing={scopes.isAnalyzing}
        sourceStatus={scopes.sourceStatus}
        sourceWidth={scopes.sourceWidth}
        sourceHeight={scopes.sourceHeight}
        lastAnalyzedAt={scopes.lastAnalyzedAt}
        error={scopes.error}
        onRefresh={scopes.analyze}
        className="min-h-full"
      />
    </div>
  );
}

export default PreviewScopesPanel;
