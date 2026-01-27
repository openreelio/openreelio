/**
 * QuickActionsBar Component Tests
 *
 * TDD tests for the quick action buttons in the AI sidebar.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuickActionsBar } from './QuickActionsBar';

// =============================================================================
// Mocks
// =============================================================================

const mockGenerateEditScript = vi.fn();

vi.mock('@/stores/aiStore', () => ({
  useAIStore: (selector: (state: unknown) => unknown) => {
    const state = {
      isGenerating: false,
      generateEditScript: mockGenerateEditScript,
    };
    return selector(state);
  },
}));

vi.mock('@/stores', () => ({
  useTimelineStore: (selector: (state: unknown) => unknown) => {
    const state = {
      playhead: 5.5,
      selectedClipIds: ['clip_001'],
      selectedTrackIds: ['track_001'],
    };
    return selector(state);
  },
}));

// =============================================================================
// Tests
// =============================================================================

describe('QuickActionsBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEditScript.mockResolvedValue({});
  });

  describe('Rendering', () => {
    it('renders with test id', () => {
      render(<QuickActionsBar />);
      expect(screen.getByTestId('quick-actions-bar')).toBeInTheDocument();
    });

    it('renders quick action buttons', () => {
      render(<QuickActionsBar />);

      // Buttons have aria-label set to description or label
      expect(screen.getByRole('button', { name: /generate subtitles/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /detect and remove silent/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /auto-detect scene changes/i })).toBeInTheDocument();
    });

    it('renders labels for actions', () => {
      render(<QuickActionsBar />);

      expect(screen.getByText('Add Captions')).toBeInTheDocument();
      expect(screen.getByText('Remove Silence')).toBeInTheDocument();
      expect(screen.getByText('Split Scenes')).toBeInTheDocument();
    });
  });

  describe('Action Buttons', () => {
    it('calls generateEditScript with correct intent when Add Captions clicked', async () => {
      const user = userEvent.setup();
      render(<QuickActionsBar />);

      await user.click(screen.getByText('Add Captions'));

      expect(mockGenerateEditScript).toHaveBeenCalledWith(
        'Add captions to the selected clips',
        expect.objectContaining({
          playheadPosition: 5.5,
          selectedClips: ['clip_001'],
          selectedTracks: ['track_001'],
        })
      );
    });

    it('calls generateEditScript with correct intent when Remove Silence clicked', async () => {
      const user = userEvent.setup();
      render(<QuickActionsBar />);

      await user.click(screen.getByText('Remove Silence'));

      expect(mockGenerateEditScript).toHaveBeenCalledWith(
        'Remove all silent parts from the timeline',
        expect.any(Object)
      );
    });

    it('calls generateEditScript with correct intent when Split Scenes clicked', async () => {
      const user = userEvent.setup();
      render(<QuickActionsBar />);

      await user.click(screen.getByText('Split Scenes'));

      expect(mockGenerateEditScript).toHaveBeenCalledWith(
        'Split the video by scene changes',
        expect.any(Object)
      );
    });
  });

  describe('Custom Actions', () => {
    it('renders custom actions when provided', () => {
      const customActions = [
        { id: 'custom_1', label: 'Custom Action', icon: '⚡', intent: 'Do something custom' },
      ];
      render(<QuickActionsBar customActions={customActions} />);

      expect(screen.getByText('Custom Action')).toBeInTheDocument();
    });

    it('calls generateEditScript with custom intent', async () => {
      const user = userEvent.setup();
      const customActions = [
        { id: 'custom_1', label: 'Custom', icon: '⚡', intent: 'Do something custom' },
      ];
      render(<QuickActionsBar customActions={customActions} />);

      await user.click(screen.getByText('Custom'));

      expect(mockGenerateEditScript).toHaveBeenCalledWith(
        'Do something custom',
        expect.any(Object)
      );
    });
  });

  describe('Styling', () => {
    it('applies custom className', () => {
      render(<QuickActionsBar className="custom-class" />);
      expect(screen.getByTestId('quick-actions-bar')).toHaveClass('custom-class');
    });
  });
});
