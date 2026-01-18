/**
 * UndoRedoButtons Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UndoRedoButtons } from './UndoRedoButtons';

// Mock project store
vi.mock('@/stores', () => ({
  useProjectStore: vi.fn(() => ({
    isLoaded: true,
    undo: vi.fn().mockResolvedValue(undefined),
    redo: vi.fn().mockResolvedValue(undefined),
    canUndo: vi.fn().mockResolvedValue(false),
    canRedo: vi.fn().mockResolvedValue(false),
  })),
}));

import { useProjectStore } from '@/stores';

const mockUseProjectStore = vi.mocked(useProjectStore);

describe('UndoRedoButtons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseProjectStore.mockReturnValue({
      isLoaded: true,
      undo: vi.fn().mockResolvedValue(undefined),
      redo: vi.fn().mockResolvedValue(undefined),
      canUndo: vi.fn().mockResolvedValue(false),
      canRedo: vi.fn().mockResolvedValue(false),
    } as unknown as ReturnType<typeof useProjectStore>);
  });

  // ===========================================================================
  // Render Tests
  // ===========================================================================

  it('renders undo and redo buttons', async () => {
    render(<UndoRedoButtons />);

    await waitFor(() => {
      expect(screen.getByTestId('undo-button')).toBeInTheDocument();
      expect(screen.getByTestId('redo-button')).toBeInTheDocument();
    });
  });

  it('disables buttons when no actions available', async () => {
    mockUseProjectStore.mockReturnValue({
      isLoaded: true,
      undo: vi.fn().mockResolvedValue(undefined),
      redo: vi.fn().mockResolvedValue(undefined),
      canUndo: vi.fn().mockResolvedValue(false),
      canRedo: vi.fn().mockResolvedValue(false),
    } as unknown as ReturnType<typeof useProjectStore>);

    render(<UndoRedoButtons />);

    await waitFor(() => {
      expect(screen.getByTestId('undo-button')).toBeDisabled();
      expect(screen.getByTestId('redo-button')).toBeDisabled();
    });
  });

  it('enables undo button when undo is available', async () => {
    mockUseProjectStore.mockReturnValue({
      isLoaded: true,
      undo: vi.fn().mockResolvedValue(undefined),
      redo: vi.fn().mockResolvedValue(undefined),
      canUndo: vi.fn().mockResolvedValue(true),
      canRedo: vi.fn().mockResolvedValue(false),
    } as unknown as ReturnType<typeof useProjectStore>);

    render(<UndoRedoButtons />);

    await waitFor(() => {
      expect(screen.getByTestId('undo-button')).not.toBeDisabled();
      expect(screen.getByTestId('redo-button')).toBeDisabled();
    });
  });

  it('enables redo button when redo is available', async () => {
    mockUseProjectStore.mockReturnValue({
      isLoaded: true,
      undo: vi.fn().mockResolvedValue(undefined),
      redo: vi.fn().mockResolvedValue(undefined),
      canUndo: vi.fn().mockResolvedValue(false),
      canRedo: vi.fn().mockResolvedValue(true),
    } as unknown as ReturnType<typeof useProjectStore>);

    render(<UndoRedoButtons />);

    await waitFor(() => {
      expect(screen.getByTestId('undo-button')).toBeDisabled();
      expect(screen.getByTestId('redo-button')).not.toBeDisabled();
    });
  });

  // ===========================================================================
  // Project Not Loaded Tests
  // ===========================================================================

  it('disables buttons when project is not loaded', async () => {
    mockUseProjectStore.mockReturnValue({
      isLoaded: false,
      undo: vi.fn().mockResolvedValue(undefined),
      redo: vi.fn().mockResolvedValue(undefined),
      canUndo: vi.fn().mockResolvedValue(false),
      canRedo: vi.fn().mockResolvedValue(false),
    } as unknown as ReturnType<typeof useProjectStore>);

    render(<UndoRedoButtons />);

    await waitFor(() => {
      expect(screen.getByTestId('undo-button')).toBeDisabled();
      expect(screen.getByTestId('redo-button')).toBeDisabled();
    });
  });

  // ===========================================================================
  // Click Tests
  // ===========================================================================

  it('calls undo store method when undo button clicked', async () => {
    const mockUndo = vi.fn().mockResolvedValue(undefined);
    mockUseProjectStore.mockReturnValue({
      isLoaded: true,
      undo: mockUndo,
      redo: vi.fn().mockResolvedValue(undefined),
      canUndo: vi.fn().mockResolvedValue(true),
      canRedo: vi.fn().mockResolvedValue(false),
    } as unknown as ReturnType<typeof useProjectStore>);

    render(<UndoRedoButtons />);

    await waitFor(() => {
      expect(screen.getByTestId('undo-button')).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId('undo-button'));

    await waitFor(() => {
      expect(mockUndo).toHaveBeenCalledTimes(1);
    });
  });

  it('calls redo store method when redo button clicked', async () => {
    const mockRedo = vi.fn().mockResolvedValue(undefined);
    mockUseProjectStore.mockReturnValue({
      isLoaded: true,
      undo: vi.fn().mockResolvedValue(undefined),
      redo: mockRedo,
      canUndo: vi.fn().mockResolvedValue(false),
      canRedo: vi.fn().mockResolvedValue(true),
    } as unknown as ReturnType<typeof useProjectStore>);

    render(<UndoRedoButtons />);

    await waitFor(() => {
      expect(screen.getByTestId('redo-button')).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId('redo-button'));

    await waitFor(() => {
      expect(mockRedo).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Callback Tests
  // ===========================================================================

  it('calls onUndo callback after successful undo', async () => {
    const onUndo = vi.fn();
    const mockUndo = vi.fn().mockResolvedValue(undefined);
    mockUseProjectStore.mockReturnValue({
      isLoaded: true,
      undo: mockUndo,
      redo: vi.fn().mockResolvedValue(undefined),
      canUndo: vi.fn().mockResolvedValue(true),
      canRedo: vi.fn().mockResolvedValue(false),
    } as unknown as ReturnType<typeof useProjectStore>);

    render(<UndoRedoButtons onUndo={onUndo} />);

    await waitFor(() => {
      expect(screen.getByTestId('undo-button')).not.toBeDisabled();
    });

    fireEvent.click(screen.getByTestId('undo-button'));

    await waitFor(() => {
      expect(onUndo).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  it('has correct aria labels', async () => {
    render(<UndoRedoButtons />);

    await waitFor(() => {
      expect(screen.getByTestId('undo-button')).toHaveAttribute('aria-label', 'Undo');
      expect(screen.getByTestId('redo-button')).toHaveAttribute('aria-label', 'Redo');
    });
  });

  it('has correct title attributes for tooltips', async () => {
    render(<UndoRedoButtons />);

    await waitFor(() => {
      expect(screen.getByTestId('undo-button')).toHaveAttribute('title', 'Undo (Ctrl+Z)');
      expect(screen.getByTestId('redo-button')).toHaveAttribute('title', 'Redo (Ctrl+Shift+Z)');
    });
  });
});
