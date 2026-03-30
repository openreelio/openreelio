/**
 * ColorMatchSection Component Tests
 *
 * BDD-style integration tests for the auto color match section.
 * Tests rendering, user interactions, reference clip selection, and IPC invocation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ColorMatchSection } from './ColorMatchSection';

// Mock Tauri IPC
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock stores
const mockSequences = new Map();
let mockActiveSequenceId = 'seq-001';
const mockSelectedClipIds: string[] = [];

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      sequences: mockSequences,
      activeSequenceId: mockActiveSequenceId,
    }),
}));

vi.mock('@/stores/timelineStore', () => ({
  useTimelineStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedClipIds: mockSelectedClipIds,
    }),
}));

vi.mock('@/utils/stateRefreshHelper', () => ({
  refreshProjectState: vi.fn().mockResolvedValue({}),
}));

// =============================================================================
// Test Helpers
// =============================================================================

function setupSequenceWithClips(): void {
  mockSequences.set('seq-001', {
    id: 'seq-001',
    tracks: [
      {
        id: 'track-001',
        kind: 'video',
        clips: [
          {
            id: 'clip-001',
            assetId: 'asset-001',
            label: 'Interview Shot',
            range: { sourceInSec: 0, sourceOutSec: 10 },
            place: { timelineInSec: 0, durationSec: 10 },
          },
          {
            id: 'clip-002',
            assetId: 'asset-002',
            label: 'B-Roll',
            range: { sourceInSec: 0, sourceOutSec: 5 },
            place: { timelineInSec: 10, durationSec: 5 },
          },
          {
            id: 'clip-003',
            assetId: 'asset-003',
            label: null,
            range: { sourceInSec: 0, sourceOutSec: 8 },
            place: { timelineInSec: 15, durationSec: 8 },
          },
        ],
      },
      {
        id: 'track-002',
        kind: 'audio',
        clips: [{ id: 'audio-clip-001', assetId: 'audio-asset-001' }],
      },
    ],
  });
}

function setupAlternateSequenceWithClips(): void {
  mockSequences.set('seq-002', {
    id: 'seq-002',
    tracks: [
      {
        id: 'track-101',
        kind: 'video',
        clips: [
          {
            id: 'clip-101',
            assetId: 'asset-101',
            label: 'Alt Target',
            range: { sourceInSec: 1, sourceOutSec: 11 },
            place: { timelineInSec: 0, durationSec: 10 },
          },
          {
            id: 'clip-102',
            assetId: 'asset-102',
            label: 'Alt Reference',
            range: { sourceInSec: 0, sourceOutSec: 7 },
            place: { timelineInSec: 10, durationSec: 7 },
          },
        ],
      },
    ],
  });
}

const DEFAULT_CLIP_CONTEXT = {
  sequenceId: 'seq-001',
  trackId: 'track-001',
  clipId: 'clip-001',
};

const MATCH_RESULT = {
  effectId: 'effect-new-001',
  brightnessOffset: 0.15,
  saturationMultiplier: 1.3,
  temperatureShift: 0.08,
};

// =============================================================================
// Tests
// =============================================================================

describe('ColorMatchSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSequences.clear();
    mockSelectedClipIds.splice(0, mockSelectedClipIds.length);
    mockActiveSequenceId = 'seq-001';
    setupSequenceWithClips();
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe('Rendering', () => {
    it('should render collapsed by default with header', () => {
      // Given a color match section
      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} />);

      // Then the header should be visible
      expect(screen.getByText('Color Match')).toBeInTheDocument();

      // And the content should be collapsed (no select visible)
      expect(screen.queryByLabelText('Select reference clip')).not.toBeInTheDocument();
    });

    it('should expand when header is clicked', () => {
      // Given a collapsed section
      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} />);

      // When clicking the header
      fireEvent.click(screen.getByLabelText('Toggle color match section'));

      // Then the content should be visible
      expect(screen.getByLabelText('Select reference clip')).toBeInTheDocument();
      expect(screen.getByText('Match Color')).toBeInTheDocument();
    });

    it('should collapse when header is clicked again', () => {
      // Given an expanded section
      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} />);
      fireEvent.click(screen.getByLabelText('Toggle color match section'));

      // When clicking the header again
      fireEvent.click(screen.getByLabelText('Toggle color match section'));

      // Then the content should be hidden
      expect(screen.queryByLabelText('Select reference clip')).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Reference Clip Picker
  // ---------------------------------------------------------------------------

  describe('Reference Clip Picker', () => {
    it('should list only non-target video clips in the dropdown', () => {
      // Given the section is expanded with clip-001 as target
      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} />);
      fireEvent.click(screen.getByLabelText('Toggle color match section'));

      // When looking at the dropdown options
      const select = screen.getByLabelText('Select reference clip') as HTMLSelectElement;
      const options = Array.from(select.options);

      // Then it should show clip-002 and clip-003 but not clip-001 (target)
      const values = options.map((o) => o.value);
      expect(values).toContain('clip-002');
      expect(values).toContain('clip-003');
      expect(values).not.toContain('clip-001');
    });

    it('should exclude audio track clips from reference list', () => {
      // Given the section is expanded
      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} />);
      fireEvent.click(screen.getByLabelText('Toggle color match section'));

      // Then audio clips should not be in the dropdown
      const select = screen.getByLabelText('Select reference clip') as HTMLSelectElement;
      const values = Array.from(select.options).map((o) => o.value);
      expect(values).not.toContain('audio-clip-001');
    });

    it('should use clip label as display text when available', () => {
      // Given the section is expanded
      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} />);
      fireEvent.click(screen.getByLabelText('Toggle color match section'));

      // Then labeled clips should show their label
      expect(screen.getByText('B-Roll')).toBeInTheDocument();
    });

    it('should use truncated asset ID when label is null', () => {
      // Given the section is expanded with clip-003 having no label
      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} />);
      fireEvent.click(screen.getByLabelText('Toggle color match section'));

      // Then it should show truncated asset ID
      expect(screen.getByText('asset-00')).toBeInTheDocument();
    });

    it('should use the clipContext sequence even when another sequence is active', () => {
      setupAlternateSequenceWithClips();
      mockActiveSequenceId = 'seq-001';

      render(
        <ColorMatchSection
          clipContext={{
            sequenceId: 'seq-002',
            trackId: 'track-101',
            clipId: 'clip-101',
          }}
        />
      );
      fireEvent.click(screen.getByLabelText('Toggle color match section'));

      const select = screen.getByLabelText('Select reference clip') as HTMLSelectElement;
      const values = Array.from(select.options).map((option) => option.value);

      expect(values).toContain('clip-102');
      expect(values).not.toContain('clip-002');
      expect(values).not.toContain('clip-003');
    });
  });

  // ---------------------------------------------------------------------------
  // Match Color Button
  // ---------------------------------------------------------------------------

  describe('Match Color Button', () => {
    it('should be disabled when no reference clip is selected', () => {
      // Given the section is expanded with no selection
      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} />);
      fireEvent.click(screen.getByLabelText('Toggle color match section'));

      // Then the match button should be disabled
      expect(screen.getByLabelText('Match color to reference clip')).toBeDisabled();
    });

    it('should be disabled in read-only mode', () => {
      // Given read-only mode
      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} readOnly />);
      fireEvent.click(screen.getByLabelText('Toggle color match section'));

      // Then the match button should be disabled
      expect(screen.getByLabelText('Match color to reference clip')).toBeDisabled();
    });

    it('should call auto_color_match IPC when clicked with selection', async () => {
      // Given a reference clip is selected
      mockInvoke.mockResolvedValue(MATCH_RESULT);

      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} />);
      fireEvent.click(screen.getByLabelText('Toggle color match section'));

      // Select a reference clip
      const select = screen.getByLabelText('Select reference clip');
      fireEvent.change(select, { target: { value: 'clip-002' } });

      // When clicking Match Color
      fireEvent.click(screen.getByLabelText('Match color to reference clip'));

      // Then it should invoke the IPC command
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('auto_color_match', {
          referenceClipId: 'clip-002',
          sequenceId: 'seq-001',
          targetClipId: 'clip-001',
        });
      });
    });

    it('should show loading state during matching', async () => {
      // Given the IPC call is pending
      mockInvoke.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(MATCH_RESULT), 100)),
      );

      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} />);
      fireEvent.click(screen.getByLabelText('Toggle color match section'));
      fireEvent.change(screen.getByLabelText('Select reference clip'), {
        target: { value: 'clip-002' },
      });

      // When matching
      fireEvent.click(screen.getByLabelText('Match color to reference clip'));

      // Then it should show loading text
      expect(screen.getByText('Analyzing...')).toBeInTheDocument();

      // Wait for completion
      await waitFor(() => {
        expect(screen.queryByText('Analyzing...')).not.toBeInTheDocument();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Result Display
  // ---------------------------------------------------------------------------

  describe('Result Display', () => {
    it('should show result summary after successful match', async () => {
      // Given a successful match
      mockInvoke.mockResolvedValue(MATCH_RESULT);

      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} />);
      fireEvent.click(screen.getByLabelText('Toggle color match section'));
      fireEvent.change(screen.getByLabelText('Select reference clip'), {
        target: { value: 'clip-002' },
      });
      fireEvent.click(screen.getByLabelText('Match color to reference clip'));

      // Then result should be displayed
      await waitFor(() => {
        expect(screen.getByTestId('color-match-result')).toBeInTheDocument();
      });

      // And show "Applied" badge in header
      expect(screen.getByText('Applied')).toBeInTheDocument();
    });

    it('should show error message on failure', async () => {
      // Given a failing IPC call
      mockInvoke.mockRejectedValue(new Error('FFmpeg not available'));

      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} />);
      fireEvent.click(screen.getByLabelText('Toggle color match section'));
      fireEvent.change(screen.getByLabelText('Select reference clip'), {
        target: { value: 'clip-002' },
      });
      fireEvent.click(screen.getByLabelText('Match color to reference clip'));

      // Then error should be displayed
      await waitFor(() => {
        expect(screen.getByTestId('color-match-error')).toBeInTheDocument();
        expect(screen.getByText('FFmpeg not available')).toBeInTheDocument();
      });
    });

    it('should call onMatchApplied callback after success', async () => {
      // Given a callback
      const onMatchApplied = vi.fn();
      mockInvoke.mockResolvedValue(MATCH_RESULT);

      render(
        <ColorMatchSection
          clipContext={DEFAULT_CLIP_CONTEXT}
          onMatchApplied={onMatchApplied}
        />,
      );
      fireEvent.click(screen.getByLabelText('Toggle color match section'));
      fireEvent.change(screen.getByLabelText('Select reference clip'), {
        target: { value: 'clip-002' },
      });
      fireEvent.click(screen.getByLabelText('Match color to reference clip'));

      // Then callback should be called
      await waitFor(() => {
        expect(onMatchApplied).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Cases
  // ---------------------------------------------------------------------------

  describe('Edge Cases', () => {
    it('should handle missing clipContext gracefully', () => {
      // Given no clip context
      render(<ColorMatchSection />);
      fireEvent.click(screen.getByLabelText('Toggle color match section'));

      // Then the button should be disabled
      expect(screen.getByLabelText('Match color to reference clip')).toBeDisabled();
    });

    it('should render empty dropdown when no other clips exist', () => {
      // Given only one clip in the sequence
      mockSequences.set('seq-001', {
        id: 'seq-001',
        tracks: [
          {
            id: 'track-001',
            kind: 'video',
            clips: [
              {
                id: 'clip-001',
                assetId: 'asset-001',
                label: 'Only Clip',
                range: { sourceInSec: 0, sourceOutSec: 10 },
                place: { timelineInSec: 0, durationSec: 10 },
              },
            ],
          },
        ],
      });

      render(<ColorMatchSection clipContext={DEFAULT_CLIP_CONTEXT} />);
      fireEvent.click(screen.getByLabelText('Toggle color match section'));

      // Then dropdown should only have the placeholder option
      const select = screen.getByLabelText('Select reference clip') as HTMLSelectElement;
      expect(select.options.length).toBe(1);
      expect(select.options[0].textContent).toBe('Select a clip...');
    });
  });
});
