/**
 * FFmpegWarning Component Tests
 *
 * Integration-style tests: only the Tauri IPC boundary (`@tauri-apps/api/*`)
 * is mocked (globally, in src/test/setup.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { FFmpegWarning } from './FFmpegWarning';
import type { FFmpegInstallProgress } from '@/hooks/useFFmpegInstaller';

const INSTALLED_STATUS = {
  available: true,
  version: '7.1',
  isBundled: false,
  ffmpegPath: '/managed/bin/ffmpeg',
  ffprobePath: '/managed/bin/ffprobe',
  source: 'managed',
};

describe('FFmpegWarning', () => {
  const mockOnDismiss = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listen).mockResolvedValue(() => {});
  });

  // ===========================================================================
  // Visibility Tests
  // ===========================================================================

  it('renders nothing when isOpen is false', () => {
    render(<FFmpegWarning isOpen={false} onDismiss={mockOnDismiss} />);
    expect(screen.queryByTestId('ffmpeg-warning')).not.toBeInTheDocument();
  });

  it('renders the dialog when isOpen is true', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} />);
    expect(screen.getByTestId('ffmpeg-warning')).toBeInTheDocument();
  });

  // ===========================================================================
  // Content Tests
  // ===========================================================================

  it('displays the warning title', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} />);
    expect(screen.getByText('FFmpeg Not Found')).toBeInTheDocument();
  });

  it('displays installation instructions for all platforms', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} />);
    expect(screen.getByText('Windows:')).toBeInTheDocument();
    expect(screen.getByText('macOS:')).toBeInTheDocument();
    expect(screen.getByText('Linux (Debian/Ubuntu):')).toBeInTheDocument();
  });

  it('displays the homebrew command for macOS', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} />);
    expect(screen.getByText('brew install ffmpeg')).toBeInTheDocument();
  });

  it('displays the apt command for Linux', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} />);
    expect(screen.getByText('sudo apt install ffmpeg')).toBeInTheDocument();
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  it('calls onDismiss when dismiss button is clicked', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} />);
    fireEvent.click(screen.getByTestId('ffmpeg-warning-dismiss'));
    expect(mockOnDismiss).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss when backdrop is clicked and allowDismiss is true', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} allowDismiss={true} />);
    fireEvent.click(screen.getByTestId('ffmpeg-warning-backdrop'));
    expect(mockOnDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not call onDismiss when backdrop is clicked and allowDismiss is false', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} allowDismiss={false} />);
    fireEvent.click(screen.getByTestId('ffmpeg-warning-backdrop'));
    expect(mockOnDismiss).not.toHaveBeenCalled();
  });

  it('calls onDismiss when Escape key is pressed and allowDismiss is true', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} allowDismiss={true} />);
    fireEvent.keyDown(screen.getByTestId('ffmpeg-warning'), { key: 'Escape' });
    expect(mockOnDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not call onDismiss when Escape key is pressed and allowDismiss is false', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} allowDismiss={false} />);
    fireEvent.keyDown(screen.getByTestId('ffmpeg-warning'), { key: 'Escape' });
    expect(mockOnDismiss).not.toHaveBeenCalled();
  });

  it('hides dismiss button when allowDismiss is false', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} allowDismiss={false} />);
    expect(screen.queryByTestId('ffmpeg-warning-dismiss')).not.toBeInTheDocument();
  });

  // ===========================================================================
  // Link Tests
  // ===========================================================================

  it('has an official download button', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} />);
    expect(screen.getByText('Official Download')).toBeInTheDocument();
  });

  it('opens external link when download button is clicked', () => {
    const mockOpen = vi.fn();
    vi.stubGlobal('open', mockOpen);

    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} />);
    fireEvent.click(screen.getByText('Official Download'));

    expect(mockOpen).toHaveBeenCalledWith(
      'https://ffmpeg.org/download.html',
      '_blank',
      'noopener,noreferrer',
    );

    vi.unstubAllGlobals();
  });

  // ===========================================================================
  // Automatic Install Flow Tests
  // ===========================================================================

  it('should show progress while installing and success plus recheck when install completes', async () => {
    const mockOnRecheck = vi.fn();

    // Capture the progress-event handler the hook subscribes with.
    let progressHandler: ((event: { payload: FFmpegInstallProgress }) => void) | null = null;
    vi.mocked(listen).mockImplementation((eventName, handler) => {
      if (eventName === 'ffmpeg-install-progress') {
        progressHandler = handler as (event: { payload: FFmpegInstallProgress }) => void;
      }
      return Promise.resolve(() => {});
    });

    // Keep the install command pending until we resolve it manually.
    let resolveInstall: (value: unknown) => void = () => {};
    vi.mocked(invoke).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve;
        }),
    );

    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} onRecheck={mockOnRecheck} />);

    fireEvent.click(screen.getByTestId('ffmpeg-warning-install'));

    // Progress UI appears while the install is running.
    await waitFor(() => {
      expect(screen.getByTestId('ffmpeg-install-progress')).toBeInTheDocument();
    });

    // A streamed progress event updates the visible stage.
    await waitFor(() => expect(progressHandler).not.toBeNull());
    act(() => {
      progressHandler?.({
        payload: {
          stage: 'downloading',
          binary: 'ffmpeg',
          downloadedBytes: 50 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
        },
      });
    });
    await waitFor(() => {
      expect(screen.getByText(/Downloading ffmpeg/)).toBeInTheDocument();
    });

    // Completing the command shows the success state and triggers a recheck.
    await act(async () => {
      resolveInstall(INSTALLED_STATUS);
    });
    await waitFor(() => {
      expect(screen.getByTestId('ffmpeg-install-success')).toBeInTheDocument();
    });
    expect(mockOnRecheck).toHaveBeenCalled();
  });

  it('should show an error message when the install fails', async () => {
    const mockOnRecheck = vi.fn();
    vi.mocked(invoke).mockRejectedValue('All download URLs failed for ffmpeg');

    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} onRecheck={mockOnRecheck} />);

    fireEvent.click(screen.getByTestId('ffmpeg-warning-install'));

    await waitFor(() => {
      expect(screen.getByTestId('ffmpeg-install-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/All download URLs failed/)).toBeInTheDocument();
    expect(mockOnRecheck).not.toHaveBeenCalled();
    // The install button returns so the user can retry.
    expect(screen.getByTestId('ffmpeg-warning-install')).toBeInTheDocument();
  });

  it('should call onRecheck when Check Again is clicked', () => {
    const mockOnRecheck = vi.fn();
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} onRecheck={mockOnRecheck} />);

    fireEvent.click(screen.getByTestId('ffmpeg-warning-recheck'));
    expect(mockOnRecheck).toHaveBeenCalledTimes(1);
  });

  it('should hide Check Again when no onRecheck handler is provided', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} />);
    expect(screen.queryByTestId('ffmpeg-warning-recheck')).not.toBeInTheDocument();
  });

  it('should keep manual instructions available behind an accordion', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} />);
    expect(screen.getByTestId('ffmpeg-manual-instructions')).toBeInTheDocument();
    expect(screen.getByText('Manual installation')).toBeInTheDocument();
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  it('has correct ARIA attributes', () => {
    render(<FFmpegWarning isOpen={true} onDismiss={mockOnDismiss} />);
    const dialog = screen.getByTestId('ffmpeg-warning');
    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
  });
});
