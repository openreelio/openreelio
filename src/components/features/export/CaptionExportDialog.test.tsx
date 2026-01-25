import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CaptionExportDialog } from './CaptionExportDialog';
import type { Caption } from '@/types';

// Mock the hook
const mockExportToFile = vi.fn();
vi.mock('@/hooks/useCaptionExport', () => ({
  useCaptionExport: () => ({
    exportToFile: mockExportToFile,
    isExporting: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

describe('CaptionExportDialog', () => {
  const mockCaptions: Caption[] = [
    { id: '1', text: 'Hello', startSec: 0, endSec: 2 },
    { id: '2', text: 'World', startSec: 2, endSec: 4 },
  ];

  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    captions: mockCaptions,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExportToFile.mockResolvedValue(true);
  });

  it('renders correctly when open', () => {
    render(<CaptionExportDialog {...defaultProps} />);

    expect(screen.getByText('Export Captions')).toBeInTheDocument();
    expect(screen.getByText('Format')).toBeInTheDocument();
    expect(screen.getByLabelText('SubRip (.srt)')).toBeInTheDocument();
    expect(screen.getByLabelText('WebVTT (.vtt)')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<CaptionExportDialog {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('Export Captions')).not.toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked', () => {
    render(<CaptionExportDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('Cancel'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('exports as SRT by default', async () => {
    render(<CaptionExportDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('Export'));

    await waitFor(() => {
      expect(mockExportToFile).toHaveBeenCalledWith(mockCaptions, 'srt', expect.any(String));
    });
  });

  it('exports as VTT when selected', async () => {
    render(<CaptionExportDialog {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('WebVTT (.vtt)'));
    fireEvent.click(screen.getByText('Export'));

    await waitFor(() => {
      expect(mockExportToFile).toHaveBeenCalledWith(mockCaptions, 'vtt', expect.any(String));
    });
  });

  it('allows changing filename', async () => {
    render(<CaptionExportDialog {...defaultProps} />);

    const input = screen.getByLabelText('Filename');
    fireEvent.change(input, { target: { value: 'my_captions' } });
    fireEvent.click(screen.getByText('Export'));

    await waitFor(() => {
      expect(mockExportToFile).toHaveBeenCalledWith(mockCaptions, 'srt', 'my_captions');
    });
  });

  it('closes dialog on successful export', async () => {
    mockExportToFile.mockResolvedValue(true);
    render(<CaptionExportDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('Export'));

    await waitFor(() => {
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  it('does not close dialog on failed export', async () => {
    mockExportToFile.mockResolvedValue(false);
    const onClose = vi.fn();

    render(<CaptionExportDialog {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByText('Export'));

    await waitFor(() => {
      expect(mockExportToFile).toHaveBeenCalled();
    });

    // onClose should not be called when export fails
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when clicking backdrop', () => {
    render(<CaptionExportDialog {...defaultProps} />);

    // The backdrop is the outer div with fixed inset-0
    const backdrop = document.querySelector('.fixed.inset-0');
    fireEvent.click(backdrop!);

    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('does not close when clicking dialog content', () => {
    const onClose = vi.fn();
    render(<CaptionExportDialog {...defaultProps} onClose={onClose} />);

    // Click on the dialog itself, not the backdrop
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);

    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables export button when filename is empty', () => {
    render(<CaptionExportDialog {...defaultProps} defaultName="" />);

    const exportButton = screen.getByRole('button', { name: /export/i });
    expect(exportButton).toBeDisabled();
  });

  it('uses default filename when not provided', () => {
    render(<CaptionExportDialog {...defaultProps} />);

    const input = screen.getByLabelText('Filename') as HTMLInputElement;
    expect(input.value).toBe('captions');
  });

  it('uses custom default name when provided', () => {
    render(<CaptionExportDialog {...defaultProps} defaultName="my_subtitles" />);

    const input = screen.getByLabelText('Filename') as HTMLInputElement;
    expect(input.value).toBe('my_subtitles');
  });

  it('resets state when dialog opens', () => {
    const { rerender } = render(
      <CaptionExportDialog {...defaultProps} isOpen={false} defaultName="original" />
    );

    rerender(<CaptionExportDialog {...defaultProps} isOpen={true} defaultName="updated" />);

    const input = screen.getByLabelText('Filename') as HTMLInputElement;
    expect(input.value).toBe('updated');
  });
});
