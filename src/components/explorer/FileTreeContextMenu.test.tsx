import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileTreeContextMenu } from './FileTreeContextMenu';
import type { FileTreeEntry } from '@/types';

const mediaEntry: FileTreeEntry = {
  relativePath: 'audio/voice.mp3',
  name: 'voice.mp3',
  isDirectory: false,
  kind: 'audio',
  fileSize: 1024,
  assetId: 'asset_voice',
  children: [],
};

const imageEntry: FileTreeEntry = {
  relativePath: 'image/poster.jpg',
  name: 'poster.jpg',
  isDirectory: false,
  kind: 'image',
  fileSize: 2048,
  assetId: 'asset_image',
  children: [],
};

const directoryEntry: FileTreeEntry = {
  relativePath: 'footage',
  name: 'footage',
  isDirectory: true,
  children: [],
};

const rootEntry: FileTreeEntry = {
  relativePath: '',
  name: 'Workspace',
  isDirectory: true,
  children: [],
};

describe('FileTreeContextMenu', () => {
  it('should show transcribe action for audio/video assets', () => {
    render(
      <FileTreeContextMenu
        entry={mediaEntry}
        position={{ x: 20, y: 30 }}
        onClose={vi.fn()}
        onTranscribe={vi.fn()}
      />,
    );

    expect(screen.getByText('Transcribe')).toBeInTheDocument();
  });

  it('should hide transcribe action for non-transcribable asset kinds', () => {
    render(
      <FileTreeContextMenu
        entry={imageEntry}
        position={{ x: 20, y: 30 }}
        onClose={vi.fn()}
        onTranscribe={vi.fn()}
      />,
    );

    expect(screen.queryByText('Transcribe')).not.toBeInTheDocument();
  });

  it('should disable transcribe action while the asset is transcribing', () => {
    const onTranscribe = vi.fn();

    render(
      <FileTreeContextMenu
        entry={mediaEntry}
        position={{ x: 20, y: 30 }}
        onClose={vi.fn()}
        onTranscribe={onTranscribe}
        isTranscribing={true}
      />,
    );

    const transcribeButton = screen.getByRole('button', { name: 'Transcribing...' });
    fireEvent.click(transcribeButton);

    expect(transcribeButton).toBeDisabled();
    expect(onTranscribe).not.toHaveBeenCalled();
  });

  it('should expose folder management actions for directories', () => {
    const onImportFiles = vi.fn();
    const onRevealInExplorer = vi.fn();

    render(
      <FileTreeContextMenu
        entry={directoryEntry}
        position={{ x: 20, y: 30 }}
        onClose={vi.fn()}
        onImportFiles={onImportFiles}
        onRevealInExplorer={onRevealInExplorer}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Import Files...' }));
    expect(onImportFiles).toHaveBeenCalledWith(directoryEntry);

    fireEvent.click(screen.getByRole('button', { name: 'Open Folder in File Explorer' }));
    expect(onRevealInExplorer).toHaveBeenCalledWith('footage');
  });

  it('should expose workspace root actions without destructive root operations', () => {
    render(<FileTreeContextMenu entry={rootEntry} position={{ x: 20, y: 30 }} onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'New Folder' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import Files...' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Workspace Folder' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
