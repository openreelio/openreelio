/**
 * EnhancedTimelineToolbar Component Tests
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnhancedTimelineToolbar } from './EnhancedTimelineToolbar';
import { useEditorToolStore } from '@/stores/editorToolStore';
import { usePlaybackStore } from '@/stores/playbackStore';
import { useTimelineStore } from '@/stores/timelineStore';

describe('EnhancedTimelineToolbar', () => {
  beforeEach(() => {
    useTimelineStore.getState().reset();
    usePlaybackStore.getState().reset();
    useEditorToolStore.getState().reset();
  });

  it('keeps source edit targets out of the main toolbar', () => {
    render(<EnhancedTimelineToolbar hasActiveSequence />);

    expect(screen.queryByTestId('edit-target-group')).not.toBeInTheDocument();
  });

  it('renders the trim mode panel and switches trim tools', () => {
    render(<EnhancedTimelineToolbar hasActiveSequence />);

    expect(screen.getByTestId('trim-mode-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('tool-button-rate-stretch'));

    expect(useEditorToolStore.getState().activeTool).toBe('rate-stretch');
    expect(screen.getByTestId('tool-button-rate-stretch')).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onCreateMulticamGroup when multicam creation is available', () => {
    const onCreateMulticamGroup = vi.fn();

    render(
      <EnhancedTimelineToolbar
        hasActiveSequence
        hasSelectedClips
        canCreateMulticamGroup
        onCreateMulticamGroup={onCreateMulticamGroup}
      />,
    );

    fireEvent.click(screen.getByTestId('create-multicam-group-button'));

    expect(onCreateMulticamGroup).toHaveBeenCalledTimes(1);
  });

  it('disables multicam creation when fewer than two clips are selected', () => {
    render(<EnhancedTimelineToolbar hasActiveSequence hasSelectedClips />);

    expect(screen.getByTestId('create-multicam-group-button')).toBeDisabled();
  });
});
