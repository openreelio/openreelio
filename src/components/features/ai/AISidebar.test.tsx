import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AISidebar } from './AISidebar';

vi.mock('@/stores', () => ({
  useUIStore: (selector: (state: { openSettings: () => void }) => unknown) =>
    selector({ openSettings: vi.fn() }),
}));

vi.mock('@/stores/aiStore', () => ({
  useAIStore: (
    selector: (state: {
      providerStatus: {
        isConfigured: boolean;
        isAvailable: boolean;
        currentModel: string;
      };
      syncFromSettings: () => Promise<void>;
    }) => unknown,
  ) =>
    selector({
      providerStatus: {
        isConfigured: true,
        isAvailable: true,
        currentModel: 'test-model',
      },
      syncFromSettings: vi.fn().mockResolvedValue(undefined),
    }),
}));

vi.mock('@/components/features/agent', () => ({
  AgenticSidebarContent: () => <div data-testid="agentic-sidebar-content" />,
}));

describe('AISidebar', () => {
  it('should defer sizing and resize controls to the dock zone in panel mode', () => {
    render(
      <AISidebar
        collapsed={false}
        onToggle={vi.fn()}
        width={520}
        onWidthChange={vi.fn()}
        layoutMode="panel"
      />,
    );

    const sidebar = screen.getByTestId('ai-sidebar');
    expect(sidebar).toHaveStyle({ width: '100%' });
    expect(sidebar).not.toHaveClass('transition-all');
    expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument();
  });

  it('should keep legacy sidebar sizing when explicitly rendered in sidebar mode', () => {
    render(
      <AISidebar
        collapsed={false}
        onToggle={vi.fn()}
        width={520}
        onWidthChange={vi.fn()}
        layoutMode="sidebar"
      />,
    );

    expect(screen.getByTestId('ai-sidebar')).toHaveStyle({ width: '520px' });
    expect(screen.getByTestId('resize-handle')).toBeInTheDocument();
  });
});
