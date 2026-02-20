/**
 * FileTreeItem Component Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileTreeItem } from './FileTreeItem';
import type { FileTreeEntry } from '@/types';

function createFileEntry(overrides: Partial<FileTreeEntry> = {}): FileTreeEntry {
  return {
    relativePath: 'footage/interview.mp4',
    name: 'interview.mp4',
    isDirectory: false,
    kind: 'video',
    fileSize: 1024,
    assetId: undefined,
    children: [],
    ...overrides,
  };
}

describe('FileTreeItem', () => {
  it('renders file name', () => {
    const entry = createFileEntry();

    render(<FileTreeItem entry={entry} />);

    expect(screen.getByText('interview.mp4')).toBeInTheDocument();
  });

  it('renders file size for non-directory entries', () => {
    const entry = createFileEntry({ fileSize: 1024 * 1024 * 5 });

    render(<FileTreeItem entry={entry} />);

    expect(screen.getByText('5.0 MB')).toBeInTheDocument();
  });

  it('renders directory entries with expand/collapse', () => {
    const entry = createFileEntry({
      relativePath: 'footage',
      name: 'footage',
      isDirectory: true,
      children: [createFileEntry({ relativePath: 'footage/clip.mp4', name: 'clip.mp4' })],
    });

    render(<FileTreeItem entry={entry} />);

    expect(screen.getByText('footage')).toBeInTheDocument();
  });

  it('includes workspace metadata in drag payload', () => {
    const entry = createFileEntry({
      kind: 'image',
      relativePath: 'images/logo.png',
      name: 'logo.png',
      assetId: 'asset_logo',
    });

    render(<FileTreeItem entry={entry} />);

    const row = screen.getByTitle('images/logo.png');
    const setData = vi.fn();
    const dragEventDataTransfer = {
      setData,
      effectAllowed: 'none',
    };

    fireEvent.dragStart(row, {
      dataTransfer: dragEventDataTransfer,
    });

    expect(setData).toHaveBeenCalledWith('application/x-workspace-file', 'images/logo.png');
    expect(setData).toHaveBeenCalledWith(
      'application/json',
      JSON.stringify({
        assetId: 'asset_logo',
        kind: 'image',
        workspaceRelativePath: 'images/logo.png',
      }),
    );
    expect(setData).toHaveBeenCalledWith('text/plain', 'asset_logo');
  });

  it('makes all non-directory entries draggable', () => {
    const entry = createFileEntry();

    render(<FileTreeItem entry={entry} />);

    const row = screen.getByTitle('footage/interview.mp4');
    expect(row).toHaveAttribute('draggable', 'true');
  });

  it('prevents drag on directory entries', () => {
    const entry = createFileEntry({
      relativePath: 'footage',
      name: 'footage',
      isDirectory: true,
      children: [],
    });

    render(<FileTreeItem entry={entry} />);

    const row = screen.getByTitle('footage');
    expect(row).toHaveAttribute('draggable', 'false');
  });
});
