/**
 * FileTreeItem Component Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileTreeItem } from './FileTreeItem';
import type { FileTreeEntry } from '@/types';
import { TIMELINE_ASSET_DRAG_END_EVENT } from '@/utils/timelineAssetDrag';

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

  it('emits pointer-driven timeline drag payload for non-directory entries', () => {
    const entry = createFileEntry({
      assetId: 'asset_interview',
    });
    const handleDragEnd = vi.fn();
    document.addEventListener(TIMELINE_ASSET_DRAG_END_EVENT, handleDragEnd);

    try {
      render(<FileTreeItem entry={entry} />);

      const row = screen.getByTitle('footage/interview.mp4');
      expect(row).toHaveAttribute('draggable', 'false');

      fireEvent.pointerDown(row, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(document, { pointerId: 1, clientX: 30, clientY: 10 });
      fireEvent.pointerUp(document, { pointerId: 1, clientX: 30, clientY: 10 });

      expect(handleDragEnd).toHaveBeenCalledTimes(1);
      expect((handleDragEnd.mock.calls[0][0] as CustomEvent).detail.payload).toEqual({
        assetId: 'asset_interview',
        assetKind: 'video',
        label: 'interview.mp4',
        workspaceRelativePath: 'footage/interview.mp4',
      });
      expect(document.querySelector('[data-testid="timeline-asset-drag-preview"]')).toBeNull();
    } finally {
      document.removeEventListener(TIMELINE_ASSET_DRAG_END_EVENT, handleDragEnd);
    }
  });

  it('shows a drag preview while dragging a file toward the timeline', () => {
    const entry = createFileEntry({
      assetId: 'asset_interview',
    });

    render(<FileTreeItem entry={entry} />);

    const row = screen.getByTitle('footage/interview.mp4');
    fireEvent.pointerDown(row, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, { pointerId: 2, clientX: 30, clientY: 10 });

    const preview = document.querySelector('[data-testid="timeline-asset-drag-preview"]');
    expect(preview).toBeInTheDocument();
    expect(preview).toHaveTextContent('interview.mp4');

    fireEvent.pointerUp(document, { pointerId: 2, clientX: 30, clientY: 10 });
    expect(document.querySelector('[data-testid="timeline-asset-drag-preview"]')).toBeNull();
  });

  it('marks file rows as workspace drop target references', () => {
    const entry = createFileEntry({
      relativePath: 'footage/interview.mp4',
    });

    render(<FileTreeItem entry={entry} />);

    const row = screen.getByTitle('footage/interview.mp4');
    expect(row).toHaveAttribute('data-workspace-entry-path', 'footage/interview.mp4');
    expect(row).toHaveAttribute('data-workspace-entry-directory', 'false');
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

  it('marks directory rows as workspace drop target references', () => {
    const entry = createFileEntry({
      relativePath: 'footage',
      name: 'footage',
      isDirectory: true,
      children: [],
    });

    render(<FileTreeItem entry={entry} />);

    const row = screen.getByTitle('footage');
    expect(row).toHaveAttribute('data-workspace-entry-path', 'footage');
    expect(row).toHaveAttribute('data-workspace-entry-directory', 'true');
  });
});
