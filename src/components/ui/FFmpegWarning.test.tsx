/**
 * FFmpegWarning Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FFmpegWarning } from './FFmpegWarning';

describe('FFmpegWarning', () => {
  const mockOnDismiss = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
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
      'noopener,noreferrer'
    );

    vi.unstubAllGlobals();
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
