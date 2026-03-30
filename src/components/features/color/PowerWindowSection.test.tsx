/**
 * PowerWindowSection Component Tests
 *
 * BDD-style integration tests for the power window section.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PowerWindowSection } from './PowerWindowSection';
import type { Effect, Mask, MaskGroup } from '@/types';

// Mock useMask hook
const mockAddMask = vi.fn().mockResolvedValue('mask-001');
const mockUpdateMask = vi.fn().mockResolvedValue(true);
const mockRemoveMask = vi.fn().mockResolvedValue(true);

vi.mock('@/hooks/useMask', async () => {
  const actual = await vi.importActual('@/hooks/useMask');
  return {
    ...actual,
    useMask: () => ({
      addMask: mockAddMask,
      updateMask: mockUpdateMask,
      removeMask: mockRemoveMask,
      isAdding: false,
      isUpdating: false,
      isRemoving: false,
      error: null,
      clearError: vi.fn(),
    }),
  };
});

vi.mock('@/utils/stateRefreshHelper', () => ({
  refreshProjectState: vi.fn().mockResolvedValue({}),
}));

// =============================================================================
// Test Helpers
// =============================================================================

function createTestEffect(masks: Mask[] = []): Effect {
  const maskGroup: MaskGroup = { masks };
  return {
    id: 'effect-001',
    effectType: 'color_wheels',
    enabled: true,
    params: {},
    keyframes: {},
    order: 0,
    masks: maskGroup,
  };
}

function createTestMask(id: string, name: string, inverted = false): Mask {
  return {
    id,
    name,
    shape: { type: 'ellipse', x: 0.5, y: 0.5, radiusX: 0.25, radiusY: 0.25, rotation: 0 },
    inverted,
    feather: 0.1,
    opacity: 1.0,
    expansion: 0.0,
    blendMode: 'add',
    enabled: true,
    locked: false,
  };
}

const DEFAULT_CLIP_CONTEXT = {
  sequenceId: 'seq-001',
  trackId: 'track-001',
  clipId: 'clip-001',
};

// =============================================================================
// Tests
// =============================================================================

describe('PowerWindowSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the Power Windows header', () => {
    render(<PowerWindowSection effect={createTestEffect()} />);
    expect(screen.getByText('Power Windows')).toBeInTheDocument();
  });

  it('should be collapsed by default', () => {
    render(<PowerWindowSection effect={createTestEffect()} />);
    const toggle = screen.getByRole('button', { name: /toggle power windows/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('should expand when header is clicked', () => {
    render(
      <PowerWindowSection effect={createTestEffect()} clipContext={DEFAULT_CLIP_CONTEXT} />
    );
    const toggle = screen.getByRole('button', { name: /toggle power windows/i });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('should show mask count badge when masks exist', () => {
    const masks = [createTestMask('m1', 'Mask 1'), createTestMask('m2', 'Mask 2')];
    render(<PowerWindowSection effect={createTestEffect(masks)} />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('should not show mask count badge when no masks', () => {
    render(<PowerWindowSection effect={createTestEffect()} />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('should show add shape buttons when expanded with clip context', () => {
    render(
      <PowerWindowSection effect={createTestEffect()} clipContext={DEFAULT_CLIP_CONTEXT} />
    );
    fireEvent.click(screen.getByText('Power Windows'));

    expect(screen.getByLabelText('Add Circle power window')).toBeInTheDocument();
    expect(screen.getByLabelText('Add Rectangle power window')).toBeInTheDocument();
    expect(screen.getByLabelText('Add Gradient power window')).toBeInTheDocument();
  });

  it('should not show add buttons when read-only', () => {
    render(
      <PowerWindowSection
        effect={createTestEffect()}
        clipContext={DEFAULT_CLIP_CONTEXT}
        readOnly
      />
    );
    fireEvent.click(screen.getByText('Power Windows'));
    expect(screen.queryByLabelText('Add Circle power window')).not.toBeInTheDocument();
  });

  it('should not show add buttons when no clip context', () => {
    render(<PowerWindowSection effect={createTestEffect()} />);
    fireEvent.click(screen.getByText('Power Windows'));
    expect(screen.queryByLabelText('Add Circle power window')).not.toBeInTheDocument();
  });

  it('should show empty state message when no masks and expanded', () => {
    render(<PowerWindowSection effect={createTestEffect()} />);
    fireEvent.click(screen.getByText('Power Windows'));
    expect(screen.getByText(/no power windows/i)).toBeInTheDocument();
  });

  it('should call addMask with ellipse shape when circle button is clicked', async () => {
    render(
      <PowerWindowSection effect={createTestEffect()} clipContext={DEFAULT_CLIP_CONTEXT} />
    );
    fireEvent.click(screen.getByText('Power Windows'));
    fireEvent.click(screen.getByLabelText('Add Circle power window'));

    expect(mockAddMask).toHaveBeenCalledWith(
      expect.objectContaining({
        effectId: 'effect-001',
        shape: expect.objectContaining({ type: 'ellipse' }),
      })
    );
  });

  it('should call addMask with gradient shape when gradient button is clicked', async () => {
    render(
      <PowerWindowSection effect={createTestEffect()} clipContext={DEFAULT_CLIP_CONTEXT} />
    );
    fireEvent.click(screen.getByText('Power Windows'));
    fireEvent.click(screen.getByLabelText('Add Gradient power window'));

    expect(mockAddMask).toHaveBeenCalledWith(
      expect.objectContaining({
        effectId: 'effect-001',
        shape: expect.objectContaining({ type: 'gradient' }),
        feather: 0,
      })
    );
  });

  it('should display mask list when masks exist and section expanded', () => {
    const masks = [createTestMask('m1', 'Mask m1')];
    render(<PowerWindowSection effect={createTestEffect(masks)} />);
    fireEvent.click(screen.getByText('Power Windows'));
    expect(screen.getByText('Mask m1')).toBeInTheDocument();
  });
});
