import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreviewScopesPanel } from './PreviewScopesPanel';
import { usePreviewStore } from '@/stores/previewStore';
import { createEmptyAnalysis } from '@/utils/scopeAnalysis';

const useVideoScopesMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useVideoScopes', () => ({
  useVideoScopes: useVideoScopesMock,
}));

function mockScopes(overrides: Partial<ReturnType<typeof useVideoScopesMock>> = {}) {
  useVideoScopesMock.mockReturnValue({
    analysis: createEmptyAnalysis(),
    isAnalyzing: false,
    sourceStatus: 'unavailable',
    sourceWidth: 0,
    sourceHeight: 0,
    lastAnalyzedAt: null,
    error: null,
    analyze: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  });
}

describe('PreviewScopesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreviewStore.setState({
      programPreviewCanvas: null,
    });
    mockScopes();
  });

  it('should pass the missing preview canvas to video scopes analysis', () => {
    render(<PreviewScopesPanel autoUpdate={false} />);

    expect(useVideoScopesMock).toHaveBeenCalledWith(
      { current: null },
      expect.objectContaining({
        enabled: false,
        autoStart: false,
      }),
    );
    expect(screen.getByTestId('scope-source-status')).toHaveTextContent('No preview frame');
  });

  it('should pass the registered program preview canvas to video scopes analysis', () => {
    const canvas = document.createElement('canvas');
    usePreviewStore.setState({ programPreviewCanvas: canvas });
    mockScopes({
      sourceStatus: 'connected',
      sourceWidth: 1920,
      sourceHeight: 1080,
    });

    render(<PreviewScopesPanel />);

    expect(useVideoScopesMock).toHaveBeenCalledWith(
      { current: canvas },
      expect.objectContaining({
        enabled: true,
        autoStart: true,
      }),
    );
    expect(screen.getByTestId('scope-source-status')).toHaveTextContent('Live preview');
    expect(screen.getByTestId('scope-frame-size')).toHaveTextContent('1920x1080');
  });
});
