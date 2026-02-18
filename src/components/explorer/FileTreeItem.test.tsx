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
  it('shows registering indicator while file registration is in progress', () => {
    const entry = createFileEntry();

    render(
      <FileTreeItem
        entry={entry}
        registeringPathCounts={{
          'footage/interview.mp4': 1,
        }}
      />,
    );

    const indicator = screen.getByTitle('Registering...');
    expect(indicator).toBeInTheDocument();
    expect(indicator.querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows registered indicator when file already has an asset id', () => {
    const entry = createFileEntry({ assetId: 'asset_001' });

    render(<FileTreeItem entry={entry} />);

    expect(screen.getByTitle('Registered')).toBeInTheDocument();
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
});
