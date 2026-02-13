/**
 * AISidebar Component Tests
 *
 * TDD tests for the AI sidebar container component.
 * Tests rendering, toggle behavior, keyboard shortcuts, and child component integration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AISidebar } from './AISidebar';

// =============================================================================
// Mocks
// =============================================================================

// Mock aiStore
const mockChatMessages: unknown[] = [];
const mockIsGenerating = false;
const mockProviderStatus = {
  providerType: 'openai' as const,
  isConfigured: true,
  isAvailable: true,
  currentModel: 'gpt-4',
  availableModels: ['gpt-4', 'gpt-3.5-turbo'],
  errorMessage: null,
};
const mockLoadChatHistoryForProject = vi.fn();

vi.mock('@/stores/aiStore', () => ({
  useAIStore: (selector: (state: unknown) => unknown) => {
    const state = {
      chatMessages: mockChatMessages,
      isGenerating: mockIsGenerating,
      providerStatus: mockProviderStatus,
      currentProposal: null,
      error: null,
      currentProjectId: 'seq_001',
      addChatMessage: vi.fn(),
      generateEditScript: vi.fn(),
      clearChatHistory: vi.fn(),
      loadChatHistoryForProject: mockLoadChatHistoryForProject,
      syncFromSettings: vi.fn().mockResolvedValue(undefined),
    };
    return selector(state);
  },
}));

// Mock feature flags - default to legacy mode for existing tests
vi.mock('@/config/featureFlags', () => ({
  isAgenticEngineEnabled: vi.fn(() => false),
  isVideoGenerationEnabled: vi.fn(() => false),
}));

// Mock stores
vi.mock('@/stores', () => ({
  useTimelineStore: (selector: (state: unknown) => unknown) => {
    const state = {
      selectedClipIds: ['clip_001'],
      selectedTrackIds: ['track_001'],
    };
    return selector(state);
  },
  usePlaybackStore: (selector: (state: unknown) => unknown) => {
    const state = {
      currentTime: 5.5,
    };
    return selector(state);
  },
  useProjectStore: (selector: (state: unknown) => unknown) => {
    // Mock sequence with tracks containing clips
    const mockSequence = {
      id: 'seq_001',
      name: 'Main Sequence',
      tracks: [
        {
          id: 'track_001',
          clips: [
            { place: { timelineInSec: 0, durationSec: 120 } },
          ],
        },
      ],
    };
    const sequencesMap = new Map([['seq_001', mockSequence]]);
    const state = {
      sequences: sequencesMap,
      activeSequenceId: 'seq_001',
      assets: [],
    };
    return selector(state);
  },
  useUIStore: (selector: (state: unknown) => unknown) => {
    const state = {
      openSettings: vi.fn(),
      closeSettings: vi.fn(),
    };
    return selector(state);
  },
  useSettingsStore: (selector: (state: unknown) => unknown) => {
    const state = {
      settings: {
        ai: {
          provider: 'openai',
          model: 'gpt-4',
          apiKey: 'test-key',
          currentMonthUsageCents: 0,
          monthlyBudgetCents: 5000,
        },
      },
      getSettings: vi.fn().mockReturnValue({
        ai: {
          provider: 'openai',
          model: 'gpt-4',
          apiKey: 'test-key',
          currentMonthUsageCents: 0,
          monthlyBudgetCents: 5000,
        },
      }),
    };
    return selector(state);
  },
}));

// =============================================================================
// Test Setup
// =============================================================================

interface RenderProps {
  collapsed?: boolean;
  onToggle?: () => void;
  width?: number;
  onWidthChange?: (width: number) => void;
}

function renderAISidebar(props: RenderProps = {}) {
  const defaultProps = {
    collapsed: false,
    onToggle: vi.fn(),
    width: 320,
    onWidthChange: vi.fn(),
  };
  return render(<AISidebar {...defaultProps} {...props} />);
}

// =============================================================================
// Tests
// =============================================================================

describe('AISidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders in expanded state by default', () => {
      renderAISidebar({ collapsed: false });

      const sidebar = screen.getByTestId('ai-sidebar');
      expect(sidebar).toBeInTheDocument();
      expect(sidebar).not.toHaveClass('w-0');
    });

    it('renders in collapsed state when collapsed prop is true', () => {
      renderAISidebar({ collapsed: true });

      const sidebar = screen.getByTestId('ai-sidebar');
      expect(sidebar).toBeInTheDocument();
      expect(sidebar).toHaveClass('w-0');
    });

    it('renders the sidebar header with title', () => {
      renderAISidebar();

      expect(screen.getByText('AI Assistant')).toBeInTheDocument();
    });

    it('renders toggle button', () => {
      renderAISidebar();

      expect(screen.getByRole('button', { name: /collapse ai sidebar/i })).toBeInTheDocument();
    });

    it('renders with custom width', () => {
      renderAISidebar({ width: 400 });

      const sidebar = screen.getByTestId('ai-sidebar');
      expect(sidebar).toHaveStyle({ width: '400px' });
    });
  });

  describe('Toggle Behavior', () => {
    it('calls onToggle when toggle button is clicked', async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();
      renderAISidebar({ onToggle });

      const collapseButton = screen.getByRole('button', { name: /collapse ai sidebar/i });
      await user.click(collapseButton);

      expect(onToggle).toHaveBeenCalledOnce();
    });

    it('calls onToggle when Ctrl+/ keyboard shortcut is pressed', async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();
      renderAISidebar({ onToggle });

      await user.keyboard('{Control>}/{/Control}');

      expect(onToggle).toHaveBeenCalledOnce();
    });

    it('calls onToggle when Cmd+/ keyboard shortcut is pressed on Mac', async () => {
      const user = userEvent.setup();
      const onToggle = vi.fn();
      renderAISidebar({ onToggle });

      await user.keyboard('{Meta>}/{/Meta}');

      expect(onToggle).toHaveBeenCalledOnce();
    });
  });

  describe('Child Components', () => {
    it('renders ChatHistory component when expanded', () => {
      renderAISidebar({ collapsed: false });

      expect(screen.getByTestId('chat-history')).toBeInTheDocument();
    });

    it('renders ContextPanel component when expanded', () => {
      renderAISidebar({ collapsed: false });

      expect(screen.getByTestId('context-panel')).toBeInTheDocument();
    });

    it('renders ChatInput component when expanded', () => {
      renderAISidebar({ collapsed: false });

      expect(screen.getByTestId('chat-input')).toBeInTheDocument();
    });

    it('does not render child components when collapsed', () => {
      renderAISidebar({ collapsed: true });

      expect(screen.queryByTestId('chat-history')).not.toBeInTheDocument();
      expect(screen.queryByTestId('context-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('quick-actions-bar')).not.toBeInTheDocument();
      expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument();
    });

    it('renders QuickActionsBar component when expanded', () => {
      renderAISidebar({ collapsed: false });

      expect(screen.getByTestId('quick-actions-bar')).toBeInTheDocument();
    });
  });

  describe('Resize Behavior', () => {
    it('has resize handle when expanded', () => {
      renderAISidebar({ collapsed: false });

      expect(screen.getByTestId('resize-handle')).toBeInTheDocument();
    });

    it('does not have resize handle when collapsed', () => {
      renderAISidebar({ collapsed: true });

      expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument();
    });
  });

  describe('Provider Status', () => {
    it('shows provider status indicator when configured', () => {
      renderAISidebar();

      expect(screen.getByTestId('provider-status')).toBeInTheDocument();
      expect(screen.getByTestId('provider-status')).toHaveClass('bg-green-500');
    });
  });

  describe('Accessibility', () => {
    it('has proper aria-label for sidebar', () => {
      renderAISidebar();

      const sidebar = screen.getByTestId('ai-sidebar');
      expect(sidebar).toHaveAttribute('aria-label', 'AI Assistant Sidebar');
    });

    it('toggle button has proper aria-expanded attribute', () => {
      renderAISidebar({ collapsed: false });

      // When expanded, the collapse button has aria-expanded="true"
      const collapseButton = screen.getByRole('button', { name: /collapse ai sidebar/i });
      expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
    });

    it('toggle button reflects collapsed state in aria-expanded', () => {
      renderAISidebar({ collapsed: true });

      // When collapsed, the collapse button still exists but has aria-expanded="false"
      // Note: The "Open AI Assistant" button appears but doesn't have aria-expanded
      const collapseButton = screen.getByRole('button', { name: /collapse ai sidebar/i });
      expect(collapseButton).toHaveAttribute('aria-expanded', 'false');
    });
  });

  describe('Animation', () => {
    it('has transition class for smooth animation', () => {
      renderAISidebar();

      const sidebar = screen.getByTestId('ai-sidebar');
      expect(sidebar).toHaveClass('transition-all');
    });
  });
});
