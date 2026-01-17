/**
 * ExportDialog Component Tests
 *
 * TDD tests for the ExportDialog component functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExportDialog } from './ExportDialog';

// =============================================================================
// Mocks
// =============================================================================

// Mock Tauri dialog plugin
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}));

// Mock Tauri core invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock Tauri event listener
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

const mockedSave = vi.mocked(save);
const mockedInvoke = vi.mocked(invoke);

// =============================================================================
// Test Setup
// =============================================================================

function createDefaultProps() {
  return {
    isOpen: true,
    onClose: vi.fn(),
    sequenceId: 'seq_001',
    sequenceName: 'Test Sequence',
  };
}

function renderExportDialog(props: Partial<ReturnType<typeof createDefaultProps>> = {}) {
  const defaultProps = createDefaultProps();
  return render(<ExportDialog {...defaultProps} {...props} />);
}

// =============================================================================
// Tests
// =============================================================================

describe('ExportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders the dialog when isOpen is true', () => {
      renderExportDialog();
      expect(screen.getByTestId('export-dialog')).toBeInTheDocument();
      expect(screen.getByText('Export Video')).toBeInTheDocument();
    });

    it('does not render when isOpen is false', () => {
      renderExportDialog({ isOpen: false });
      expect(screen.queryByTestId('export-dialog')).not.toBeInTheDocument();
    });

    it('displays the sequence name', () => {
      renderExportDialog();
      expect(screen.getByText('Test Sequence')).toBeInTheDocument();
    });

    it('displays default sequence name when not provided', () => {
      renderExportDialog({ sequenceName: undefined });
      expect(screen.getByText('Untitled Sequence')).toBeInTheDocument();
    });

    it('renders all export preset options', () => {
      renderExportDialog();
      expect(screen.getByText('YouTube 1080p')).toBeInTheDocument();
      expect(screen.getByText('YouTube 4K')).toBeInTheDocument();
      expect(screen.getByText('Shorts/Reels')).toBeInTheDocument();
      expect(screen.getByText('Twitter/X')).toBeInTheDocument();
      expect(screen.getByText('Instagram')).toBeInTheDocument();
      expect(screen.getByText('WebM VP9')).toBeInTheDocument();
      expect(screen.getByText('ProRes')).toBeInTheDocument();
    });

    it('renders Browse button for output location', () => {
      renderExportDialog();
      expect(screen.getByRole('button', { name: 'Browse' })).toBeInTheDocument();
    });

    it('renders Export and Cancel buttons', () => {
      renderExportDialog();
      expect(screen.getByRole('button', { name: /Export/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });
  });

  describe('Preset Selection', () => {
    it('selects YouTube 1080p by default', () => {
      renderExportDialog();
      const preset = screen.getByText('YouTube 1080p').closest('button');
      expect(preset).toHaveClass('border-primary-500');
    });

    it('allows selecting different presets', async () => {
      const user = userEvent.setup();
      renderExportDialog();

      const proresButton = screen.getByText('ProRes').closest('button');
      expect(proresButton).not.toHaveClass('border-primary-500');

      await user.click(proresButton!);
      expect(proresButton).toHaveClass('border-primary-500');
    });
  });

  describe('Browse for Output Location', () => {
    it('opens save dialog when Browse is clicked', async () => {
      const user = userEvent.setup();
      mockedSave.mockResolvedValueOnce('/path/to/output.mp4');

      renderExportDialog();
      const browseButton = screen.getByRole('button', { name: 'Browse' });

      await user.click(browseButton);

      expect(mockedSave).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: 'Test Sequence.mp4',
          title: 'Export Video',
        })
      );
    });

    it('updates output path when file is selected', async () => {
      const user = userEvent.setup();
      mockedSave.mockResolvedValueOnce('/path/to/output.mp4');

      renderExportDialog();
      const browseButton = screen.getByRole('button', { name: 'Browse' });

      await user.click(browseButton);

      await waitFor(() => {
        const input = screen.getByPlaceholderText('Select output location');
        expect(input).toHaveValue('/path/to/output.mp4');
      });
    });

    it('uses correct extension for WebM preset', async () => {
      const user = userEvent.setup();
      mockedSave.mockResolvedValueOnce('/path/to/output.webm');

      renderExportDialog();

      // Select WebM preset
      const webmButton = screen.getByText('WebM VP9').closest('button');
      await user.click(webmButton!);

      // Click browse
      const browseButton = screen.getByRole('button', { name: 'Browse' });
      await user.click(browseButton);

      expect(mockedSave).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: 'Test Sequence.webm',
        })
      );
    });

    it('uses correct extension for ProRes preset', async () => {
      const user = userEvent.setup();
      mockedSave.mockResolvedValueOnce('/path/to/output.mov');

      renderExportDialog();

      // Select ProRes preset
      const proresButton = screen.getByText('ProRes').closest('button');
      await user.click(proresButton!);

      // Click browse
      const browseButton = screen.getByRole('button', { name: 'Browse' });
      await user.click(browseButton);

      expect(mockedSave).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: 'Test Sequence.mov',
        })
      );
    });
  });

  describe('Export Button State', () => {
    it('disables Export button when no output path is set', () => {
      renderExportDialog();
      const exportButton = screen.getByRole('button', { name: /Export/i });
      expect(exportButton).toBeDisabled();
    });

    it('enables Export button when output path is set', async () => {
      const user = userEvent.setup();
      mockedSave.mockResolvedValueOnce('/path/to/output.mp4');

      renderExportDialog();

      // Set output path
      const browseButton = screen.getByRole('button', { name: 'Browse' });
      await user.click(browseButton);

      await waitFor(() => {
        const exportButton = screen.getByRole('button', { name: /Export/i });
        expect(exportButton).not.toBeDisabled();
      });
    });

    it('disables Export button when no sequenceId is provided', () => {
      renderExportDialog({ sequenceId: undefined });
      const exportButton = screen.getByRole('button', { name: /Export/i });
      expect(exportButton).toBeDisabled();
    });
  });

  describe('Export Process', () => {
    it('starts export when Export button is clicked', async () => {
      const user = userEvent.setup();
      mockedSave.mockResolvedValueOnce('/path/to/output.mp4');
      mockedInvoke.mockResolvedValueOnce({
        jobId: 'job_001',
        outputPath: '/path/to/output.mp4',
        status: 'completed',
      });

      renderExportDialog();

      // Set output path
      const browseButton = screen.getByRole('button', { name: 'Browse' });
      await user.click(browseButton);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Select output location')).toHaveValue('/path/to/output.mp4');
      });

      // Start export
      const exportButton = screen.getByRole('button', { name: /Export/i });
      await user.click(exportButton);

      expect(mockedInvoke).toHaveBeenCalledWith(
        'start_render',
        expect.objectContaining({
          sequenceId: 'seq_001',
          outputPath: '/path/to/output.mp4',
          preset: 'youtube_1080p',
        })
      );
    });

    it('shows progress display during export', async () => {
      const user = userEvent.setup();
      mockedSave.mockResolvedValueOnce('/path/to/output.mp4');
      // Make invoke hang to simulate ongoing export
      mockedInvoke.mockImplementation(() => new Promise(() => {}));

      renderExportDialog();

      // Set output path
      const browseButton = screen.getByRole('button', { name: 'Browse' });
      await user.click(browseButton);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Select output location')).toHaveValue('/path/to/output.mp4');
      });

      // Start export
      const exportButton = screen.getByRole('button', { name: /Export/i });
      await user.click(exportButton);

      await waitFor(() => {
        expect(screen.getByText('Exporting...')).toBeInTheDocument();
      });
    });

    it('shows completion message when export succeeds', async () => {
      const user = userEvent.setup();
      mockedSave.mockResolvedValueOnce('/path/to/output.mp4');
      mockedInvoke.mockResolvedValueOnce({
        jobId: 'job_001',
        outputPath: '/path/to/output.mp4',
        status: 'completed',
      });

      renderExportDialog();

      // Set output path
      const browseButton = screen.getByRole('button', { name: 'Browse' });
      await user.click(browseButton);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Select output location')).toHaveValue('/path/to/output.mp4');
      });

      // Start export
      const exportButton = screen.getByRole('button', { name: /Export/i });
      await user.click(exportButton);

      await waitFor(() => {
        expect(screen.getByText('Export Completed!')).toBeInTheDocument();
      });
    });

    it('shows error message when export fails', async () => {
      const user = userEvent.setup();
      mockedSave.mockResolvedValueOnce('/path/to/output.mp4');
      mockedInvoke.mockRejectedValueOnce(new Error('FFmpeg not found'));

      renderExportDialog();

      // Set output path
      const browseButton = screen.getByRole('button', { name: 'Browse' });
      await user.click(browseButton);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Select output location')).toHaveValue('/path/to/output.mp4');
      });

      // Start export
      const exportButton = screen.getByRole('button', { name: /Export/i });
      await user.click(exportButton);

      await waitFor(() => {
        expect(screen.getByText('Export Failed')).toBeInTheDocument();
        expect(screen.getByText('FFmpeg not found')).toBeInTheDocument();
      });
    });
  });

  describe('Dialog Close Behavior', () => {
    it('calls onClose when Cancel button is clicked', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      renderExportDialog({ onClose });

      const cancelButton = screen.getByRole('button', { name: 'Cancel' });
      await user.click(cancelButton);

      expect(onClose).toHaveBeenCalled();
    });

    it('calls onClose when X button is clicked', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      renderExportDialog({ onClose });

      const closeButton = screen.getByRole('button', { name: 'Close dialog' });
      await user.click(closeButton);

      expect(onClose).toHaveBeenCalled();
    });

    it('calls onClose when clicking overlay', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      renderExportDialog({ onClose });

      // Click on the overlay (the div with bg-black/60)
      const overlay = screen.getByTestId('export-dialog').parentElement;
      await user.click(overlay!);

      expect(onClose).toHaveBeenCalled();
    });

    it('closes on Escape key when idle', async () => {
      const onClose = vi.fn();
      renderExportDialog({ onClose });

      fireEvent.keyDown(screen.getByTestId('export-dialog'), { key: 'Escape' });

      expect(onClose).toHaveBeenCalled();
    });

    it('does not close on Escape key during export', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      mockedSave.mockResolvedValueOnce('/path/to/output.mp4');
      mockedInvoke.mockImplementation(() => new Promise(() => {}));

      renderExportDialog({ onClose });

      // Set output path
      const browseButton = screen.getByRole('button', { name: 'Browse' });
      await user.click(browseButton);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Select output location')).toHaveValue('/path/to/output.mp4');
      });

      // Start export
      const exportButton = screen.getByRole('button', { name: /Export/i });
      await user.click(exportButton);

      // Try to close with Escape
      await waitFor(() => {
        expect(screen.getByText('Exporting...')).toBeInTheDocument();
      });

      fireEvent.keyDown(screen.getByTestId('export-dialog'), { key: 'Escape' });

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('Error Recovery', () => {
    it('allows retry after export failure', async () => {
      const user = userEvent.setup();
      mockedSave.mockResolvedValueOnce('/path/to/output.mp4');
      mockedInvoke.mockRejectedValueOnce(new Error('FFmpeg error'));

      renderExportDialog();

      // Set output path and export
      const browseButton = screen.getByRole('button', { name: 'Browse' });
      await user.click(browseButton);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Select output location')).toHaveValue('/path/to/output.mp4');
      });

      const exportButton = screen.getByRole('button', { name: /Export/i });
      await user.click(exportButton);

      // Wait for error state
      await waitFor(() => {
        expect(screen.getByText('Export Failed')).toBeInTheDocument();
      });

      // Click retry
      const retryButton = screen.getByRole('button', { name: 'Retry' });
      await user.click(retryButton);

      // Should return to settings view
      await waitFor(() => {
        expect(screen.getByText('Export Preset')).toBeInTheDocument();
        expect(screen.queryByText('Export Failed')).not.toBeInTheDocument();
      });
    });
  });

  describe('Accessibility', () => {
    it('has proper ARIA attributes', () => {
      renderExportDialog();
      const dialog = screen.getByTestId('export-dialog');
      expect(dialog).toHaveAttribute('role', 'dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'export-dialog-title');
    });

    it('has labeled title', () => {
      renderExportDialog();
      const title = screen.getByRole('heading', { name: 'Export Video' });
      expect(title).toHaveAttribute('id', 'export-dialog-title');
    });
  });
});
