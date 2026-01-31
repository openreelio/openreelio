/**
 * AddTextDialog Component Tests
 *
 * TDD: Tests for the Add Text dialog component
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddTextDialog } from './AddTextDialog';
import type { Track } from '@/types';

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// =============================================================================
// Test Data
// =============================================================================

const mockTracks: Track[] = [
  {
    id: 'track-video-1',
    name: 'Video 1',
    kind: 'video',
    locked: false,
    muted: false,
    visible: true,
    clips: [],
    blendMode: 'normal',
    volume: 1.0,
  },
  {
    id: 'track-video-2',
    name: 'Video 2',
    kind: 'video',
    locked: false,
    muted: false,
    visible: true,
    clips: [],
    blendMode: 'normal',
    volume: 1.0,
  },
  {
    id: 'track-overlay',
    name: 'Overlay',
    kind: 'overlay',
    locked: false,
    muted: false,
    visible: true,
    clips: [],
    blendMode: 'normal',
    volume: 1.0,
  },
  {
    id: 'track-audio',
    name: 'Audio',
    kind: 'audio',
    locked: false,
    muted: false,
    visible: true,
    clips: [],
    blendMode: 'normal',
    volume: 1.0,
  },
];

// =============================================================================
// Tests
// =============================================================================

describe('AddTextDialog', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onAdd: vi.fn(),
    tracks: mockTracks,
    currentTime: 5.0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // Rendering Tests
  // ===========================================================================

  describe('rendering', () => {
    it('should render dialog when open', () => {
      render(<AddTextDialog {...defaultProps} />);

      expect(screen.getByTestId('add-text-dialog')).toBeInTheDocument();
      expect(screen.getByText('Add Text')).toBeInTheDocument();
    });

    it('should not render when closed', () => {
      render(<AddTextDialog {...defaultProps} isOpen={false} />);

      expect(screen.queryByTestId('add-text-dialog')).not.toBeInTheDocument();
    });

    it('should show text content input', () => {
      render(<AddTextDialog {...defaultProps} />);

      expect(screen.getByLabelText(/text content/i)).toBeInTheDocument();
    });

    it('should show track selector with video and overlay tracks only', () => {
      render(<AddTextDialog {...defaultProps} />);

      const trackSelector = screen.getByLabelText(/track/i);
      expect(trackSelector).toBeInTheDocument();

      // Should show video and overlay tracks, not audio
      expect(screen.getByRole('option', { name: /video 1/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /video 2/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /overlay/i })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /audio/i })).not.toBeInTheDocument();
    });

    it('should show duration input with default value', () => {
      render(<AddTextDialog {...defaultProps} />);

      const durationInput = screen.getByLabelText(/duration/i);
      expect(durationInput).toBeInTheDocument();
      expect(durationInput).toHaveValue(3); // Default 3 seconds
    });

    it('should show preset buttons', () => {
      render(<AddTextDialog {...defaultProps} />);

      // Use exact name to avoid matching "Subtitle" when looking for "Title"
      expect(screen.getByRole('button', { name: 'Title' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Lower Third' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Subtitle' })).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call onClose when cancel button is clicked', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();

      render(<AddTextDialog {...defaultProps} onClose={onClose} />);

      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onClose).toHaveBeenCalled();
    });

    it('should call onAdd with correct data when Add button is clicked', async () => {
      const user = userEvent.setup();
      const onAdd = vi.fn();

      render(<AddTextDialog {...defaultProps} onAdd={onAdd} />);

      // Enter text content
      const textInput = screen.getByLabelText(/text content/i);
      await user.clear(textInput);
      await user.type(textInput, 'Hello World');

      // Click Add button
      await user.click(screen.getByRole('button', { name: /^add$/i }));

      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          trackId: expect.any(String),
          timelineIn: 5.0,
          duration: 3,
          textData: expect.objectContaining({
            content: 'Hello World',
          }),
        })
      );
    });

    it('should update duration when input changes', async () => {
      const user = userEvent.setup();
      const onAdd = vi.fn();

      render(<AddTextDialog {...defaultProps} onAdd={onAdd} />);

      const durationInput = screen.getByLabelText(/duration/i) as HTMLInputElement;

      // Use fireEvent for number inputs as userEvent can be problematic
      fireEvent.change(durationInput, { target: { value: '5' } });
      expect(durationInput.value).toBe('5');

      await user.click(screen.getByRole('button', { name: /^add$/i }));

      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          duration: 5,
        })
      );
    });

    it('should apply preset when preset button is clicked', async () => {
      const user = userEvent.setup();
      const onAdd = vi.fn();

      render(<AddTextDialog {...defaultProps} onAdd={onAdd} />);

      // Click Title preset (use exact name)
      await user.click(screen.getByRole('button', { name: 'Title' }));

      // Add text
      const textInput = screen.getByLabelText(/text content/i);
      await user.clear(textInput);
      await user.type(textInput, 'My Title');

      await user.click(screen.getByRole('button', { name: /^add$/i }));

      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          textData: expect.objectContaining({
            content: 'My Title',
            style: expect.objectContaining({
              fontSize: 72, // Title preset uses 72pt
              bold: true,
            }),
          }),
        })
      );
    });

    it('should disable Add button when text content is empty', async () => {
      const user = userEvent.setup();

      render(<AddTextDialog {...defaultProps} />);

      const textInput = screen.getByLabelText(/text content/i);
      await user.clear(textInput);

      expect(screen.getByRole('button', { name: /^add$/i })).toBeDisabled();
    });

    it('should close dialog after successful add', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(<AddTextDialog {...defaultProps} onClose={onClose} onAdd={onAdd} />);

      await user.click(screen.getByRole('button', { name: /^add$/i }));

      await waitFor(() => {
        expect(onClose).toHaveBeenCalled();
      });
    });
  });

  // ===========================================================================
  // Track Selection Tests
  // ===========================================================================

  describe('track selection', () => {
    it('should select first video track by default', () => {
      render(<AddTextDialog {...defaultProps} />);

      const trackSelector = screen.getByLabelText(/track/i) as HTMLSelectElement;
      expect(trackSelector.value).toBe('track-video-1');
    });

    it('should allow changing track selection', async () => {
      const user = userEvent.setup();
      const onAdd = vi.fn();

      render(<AddTextDialog {...defaultProps} onAdd={onAdd} />);

      const trackSelector = screen.getByLabelText(/track/i);
      await user.selectOptions(trackSelector, 'track-overlay');

      await user.click(screen.getByRole('button', { name: /^add$/i }));

      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          trackId: 'track-overlay',
        })
      );
    });

    it('should not show locked tracks', () => {
      const tracksWithLocked: Track[] = [
        ...mockTracks.slice(0, 2),
        {
          ...mockTracks[2],
          locked: true, // Lock overlay track
        },
        mockTracks[3],
      ];

      render(<AddTextDialog {...defaultProps} tracks={tracksWithLocked} />);

      // Overlay track should not be visible since it's locked
      expect(screen.queryByRole('option', { name: /overlay/i })).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Validation Tests
  // ===========================================================================

  describe('validation', () => {
    it('should enforce minimum duration of 0.5 seconds', async () => {
      const user = userEvent.setup();
      const onAdd = vi.fn();

      render(<AddTextDialog {...defaultProps} onAdd={onAdd} />);

      const durationInput = screen.getByLabelText(/duration/i);
      // Use fireEvent for number inputs
      fireEvent.change(durationInput, { target: { value: '0.1' } });

      await user.click(screen.getByRole('button', { name: /^add$/i }));

      // Should use minimum duration of 0.5
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          duration: 0.5,
        })
      );
    });

    it('should enforce maximum duration of 300 seconds', async () => {
      const user = userEvent.setup();
      const onAdd = vi.fn();

      render(<AddTextDialog {...defaultProps} onAdd={onAdd} />);

      const durationInput = screen.getByLabelText(/duration/i);
      // Use fireEvent for number inputs
      fireEvent.change(durationInput, { target: { value: '500' } });

      await user.click(screen.getByRole('button', { name: /^add$/i }));

      // Should use maximum duration of 300
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          duration: 300,
        })
      );
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('accessibility', () => {
    it('should have proper aria-label for dialog', () => {
      render(<AddTextDialog {...defaultProps} />);

      expect(screen.getByRole('dialog', { name: /add text/i })).toBeInTheDocument();
    });

    it('should trap focus within dialog', () => {
      render(<AddTextDialog {...defaultProps} />);

      // First focusable element should be the text input
      const textInput = screen.getByLabelText(/text content/i);
      expect(document.activeElement).toBe(textInput);
    });

    it('should close on Escape key', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();

      render(<AddTextDialog {...defaultProps} onClose={onClose} />);

      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalled();
    });
  });
});
