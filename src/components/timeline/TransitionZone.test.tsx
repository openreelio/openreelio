/**
 * TransitionZone Component Tests
 *
 * Tests for the transition zone that appears between adjacent clips
 * for adding/editing transitions.
 * TDD: RED phase - writing tests first
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TransitionZone } from './TransitionZone';
import type { Clip, Effect } from '@/types';

// =============================================================================
// Test Data
// =============================================================================

const mockClipA: Clip = {
  id: 'clip_001',
  assetId: 'asset_001',
  range: { sourceInSec: 0, sourceOutSec: 5 },
  place: { timelineInSec: 0, durationSec: 5 },
  transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } },
  opacity: 1,
  speed: 1,
  effects: [],
  audio: { volumeDb: 0, pan: 0, muted: false },
};

const mockClipB: Clip = {
  id: 'clip_002',
  assetId: 'asset_002',
  range: { sourceInSec: 0, sourceOutSec: 5 },
  place: { timelineInSec: 5, durationSec: 5 },
  transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } },
  opacity: 1,
  speed: 1,
  effects: [],
  audio: { volumeDb: 0, pan: 0, muted: false },
};

const mockTransitionEffect: Effect = {
  id: 'effect_001',
  effectType: 'cross_dissolve',
  enabled: true,
  params: { duration: 1.0 },
  keyframes: {},
  order: 0,
};

// =============================================================================
// Rendering Tests
// =============================================================================

describe('TransitionZone', () => {
  describe('rendering', () => {
    it('should render the transition zone container', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
        />
      );

      expect(screen.getByTestId('transition-zone')).toBeInTheDocument();
    });

    it('should position zone at the junction between clips', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          width={24}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      // ClipA ends at 5s, clipB starts at 5s, at zoom 100 = 500px
      // Zone is centered, so left = 500 - (24/2) = 488px
      expect(zone).toHaveStyle({ left: '488px' });
    });

    it('should center the zone on the junction point', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          width={24}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      // Centered on junction: 500px - (24/2) = 488px
      expect(zone).toHaveStyle({ left: '488px' });
    });

    it('should render add transition icon when no transition exists', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
        />
      );

      expect(screen.getByTestId('add-transition-icon')).toBeInTheDocument();
    });

    it('should render transition indicator when transition exists', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          transition={mockTransitionEffect}
        />
      );

      expect(screen.getByTestId('transition-indicator')).toBeInTheDocument();
    });

    it('should display transition type label when transition exists', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          transition={mockTransitionEffect}
        />
      );

      expect(screen.getByText('Cross Dissolve')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Interaction Tests
  // ===========================================================================

  describe('interactions', () => {
    it('should call onClick when zone is clicked', () => {
      const onClick = vi.fn();
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          onClick={onClick}
        />
      );

      fireEvent.click(screen.getByTestId('transition-zone'));
      expect(onClick).toHaveBeenCalledWith('clip_001', 'clip_002');
    });

    it('should call onDoubleClick when zone is double-clicked', () => {
      const onDoubleClick = vi.fn();
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          onDoubleClick={onDoubleClick}
        />
      );

      fireEvent.doubleClick(screen.getByTestId('transition-zone'));
      expect(onDoubleClick).toHaveBeenCalledWith('clip_001', 'clip_002');
    });

    it('should be keyboard accessible', () => {
      const onClick = vi.fn();
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          onClick={onClick}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      expect(zone).toHaveAttribute('tabIndex', '0');

      // Enter key should trigger click
      fireEvent.keyDown(zone, { key: 'Enter' });
      expect(onClick).toHaveBeenCalled();
    });

    it('should trigger click on Space key', () => {
      const onClick = vi.fn();
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          onClick={onClick}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      fireEvent.keyDown(zone, { key: ' ' });
      expect(onClick).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Visibility Tests
  // ===========================================================================

  describe('visibility', () => {
    it('should show zone on hover by default', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      // Should have opacity classes for hover reveal
      expect(zone.className).toMatch(/opacity/);
    });

    it('should always show zone when alwaysVisible is true', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          alwaysVisible
        />
      );

      const zone = screen.getByTestId('transition-zone');
      expect(zone).toHaveClass('opacity-100');
    });

    it('should always show zone when transition exists', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          transition={mockTransitionEffect}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      expect(zone).toHaveClass('opacity-100');
    });
  });

  // ===========================================================================
  // Disabled State Tests
  // ===========================================================================

  describe('disabled state', () => {
    it('should not trigger onClick when disabled', () => {
      const onClick = vi.fn();
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          onClick={onClick}
          disabled
        />
      );

      fireEvent.click(screen.getByTestId('transition-zone'));
      expect(onClick).not.toHaveBeenCalled();
    });

    it('should show disabled styling', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          disabled
        />
      );

      const zone = screen.getByTestId('transition-zone');
      expect(zone).toHaveClass('cursor-not-allowed');
    });

    it('should not be focusable when disabled', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          disabled
        />
      );

      const zone = screen.getByTestId('transition-zone');
      expect(zone).toHaveAttribute('tabIndex', '-1');
    });

    it('should hide delete button when disabled', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          transition={mockTransitionEffect}
          onDelete={vi.fn()}
          disabled
        />
      );

      expect(screen.queryByRole('button', { name: /delete transition/i })).not.toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Styling Tests
  // ===========================================================================

  describe('styling', () => {
    it('should apply custom className', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          className="custom-class"
        />
      );

      expect(screen.getByTestId('transition-zone')).toHaveClass('custom-class');
    });

    it('should apply custom width', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          width={32}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      expect(zone).toHaveStyle({ width: '32px' });
    });

    it('should show selected state', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          selected
        />
      );

      const zone = screen.getByTestId('transition-zone');
      expect(zone).toHaveClass('ring-2');
    });
  });

  // ===========================================================================
  // Gap Detection Tests
  // ===========================================================================

  describe('gap detection', () => {
    it('should not render when clips have a gap between them', () => {
      const clipWithGap: Clip = {
        ...mockClipB,
        place: { timelineInSec: 6, durationSec: 5 }, // 1 second gap
      };

      const { container } = render(
        <TransitionZone
          clipA={mockClipA}
          clipB={clipWithGap}
          zoom={100}
        />
      );

      expect(container.querySelector('[data-testid="transition-zone"]')).not.toBeInTheDocument();
    });

    it('should render when clips are adjacent (touching)', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
        />
      );

      expect(screen.getByTestId('transition-zone')).toBeInTheDocument();
    });

    it('should render when clips overlap slightly', () => {
      const overlappingClip: Clip = {
        ...mockClipB,
        place: { timelineInSec: 4.5, durationSec: 5 }, // 0.5 second overlap
      };

      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={overlappingClip}
          zoom={100}
        />
      );

      expect(screen.getByTestId('transition-zone')).toBeInTheDocument();
    });

    it('should use gapTolerance prop for gap detection', () => {
      const clipWithSmallGap: Clip = {
        ...mockClipB,
        place: { timelineInSec: 5.05, durationSec: 5 }, // 0.05 second gap
      };

      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={clipWithSmallGap}
          zoom={100}
          gapTolerance={0.1}
        />
      );

      // Should render because gap (0.05) is within tolerance (0.1)
      expect(screen.getByTestId('transition-zone')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // Transition Duration Display Tests
  // ===========================================================================

  describe('transition duration display', () => {
    it('should display transition duration when transition exists', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          transition={mockTransitionEffect}
        />
      );

      expect(screen.getByText('1.0s')).toBeInTheDocument();
    });

    it('should update visual width based on transition duration', () => {
      const longTransition: Effect = {
        ...mockTransitionEffect,
        params: { duration: 2.0 },
      };

      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          transition={longTransition}
        />
      );

      const indicator = screen.getByTestId('transition-indicator');
      // 2 seconds at zoom 100 = 200px width
      expect(indicator).toHaveStyle({ width: '200px' });
    });
  });

  // ===========================================================================
  // Delete Transition Tests
  // ===========================================================================

  describe('delete transition', () => {
    it('should render delete button when transition exists and onDelete provided', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          transition={mockTransitionEffect}
          onDelete={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: /delete transition/i })).toBeInTheDocument();
    });

    it('should not render delete button when no transition exists', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          onDelete={vi.fn()}
        />
      );

      expect(screen.queryByRole('button', { name: /delete transition/i })).not.toBeInTheDocument();
    });

    it('should call onDelete when delete button is clicked', () => {
      const onDelete = vi.fn();
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          transition={mockTransitionEffect}
          onDelete={onDelete}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /delete transition/i }));
      expect(onDelete).toHaveBeenCalledWith('effect_001');
    });

    it('should stop click propagation from delete button', () => {
      const onClick = vi.fn();
      const onDelete = vi.fn();
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          transition={mockTransitionEffect}
          onClick={onClick}
          onDelete={onDelete}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /delete transition/i }));
      expect(onDelete).toHaveBeenCalled();
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Security and Edge Cases
  // ===========================================================================

  describe('Security and Edge Cases', () => {
    it('should handle missing clip place data', () => {
      const invalidClip: Clip = {
        ...mockClipA,
        place: undefined as unknown as { timelineInSec: number; durationSec: number },
      };

      const { container } = render(
        <TransitionZone
          clipA={invalidClip}
          clipB={mockClipB}
          zoom={100}
        />
      );

      // Should not render with invalid data
      expect(container.querySelector('[data-testid="transition-zone"]')).not.toBeInTheDocument();
    });

    it('should handle NaN zoom value', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={NaN}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      // Should use fallback value, not NaN
      const left = zone.style.left;
      expect(left).not.toContain('NaN');
    });

    it('should handle negative zoom value', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={-100}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      // Should clamp to minimum
      const left = parseFloat(zone.style.left);
      expect(Number.isFinite(left)).toBe(true);
    });

    it('should handle very large zoom values', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={1000000}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      const left = parseFloat(zone.style.left);
      expect(Number.isFinite(left)).toBe(true);
    });

    it('should sanitize custom effect type labels', () => {
      const maliciousEffect: Effect = {
        ...mockTransitionEffect,
        effectType: { custom: '<script>alert("xss")</script>' } as unknown as 'cross_dissolve',
      };

      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          transition={maliciousEffect}
        />
      );

      // Should not render script tags
      expect(screen.queryByText('<script>')).not.toBeInTheDocument();
    });

    it('should handle Infinity in transition duration', () => {
      const infinityEffect: Effect = {
        ...mockTransitionEffect,
        params: { duration: Infinity },
      };

      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          transition={infinityEffect}
        />
      );

      // Should not crash, duration should be clamped
      const indicator = screen.queryByTestId('transition-indicator');
      if (indicator) {
        const width = parseFloat(indicator.style.width);
        expect(Number.isFinite(width)).toBe(true);
      }
    });

    it('should handle missing clip IDs gracefully', () => {
      const onClick = vi.fn();
      const clipWithNoId: Clip = {
        ...mockClipA,
        id: undefined as unknown as string,
      };

      render(
        <TransitionZone
          clipA={clipWithNoId}
          clipB={mockClipB}
          zoom={100}
          onClick={onClick}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      fireEvent.click(zone);

      // Should not call onClick with undefined IDs
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Accessibility Tests
  // ===========================================================================

  describe('Accessibility', () => {
    it('should have proper ARIA attributes', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      expect(zone).toHaveAttribute('role', 'button');
      expect(zone).toHaveAttribute('aria-label');
    });

    it('should have aria-disabled when disabled', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          disabled
        />
      );

      const zone = screen.getByTestId('transition-zone');
      expect(zone).toHaveAttribute('aria-disabled', 'true');
    });

    it('should blur on Escape key', () => {
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      zone.focus();
      expect(document.activeElement).toBe(zone);

      fireEvent.keyDown(zone, { key: 'Escape' });
      expect(document.activeElement).not.toBe(zone);
    });
  });

  // ===========================================================================
  // Concurrent Operations
  // ===========================================================================

  describe('Concurrent Operations', () => {
    it('should handle rapid click events', () => {
      const onClick = vi.fn();
      render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
          onClick={onClick}
        />
      );

      const zone = screen.getByTestId('transition-zone');

      // Simulate rapid clicks
      for (let i = 0; i < 10; i++) {
        fireEvent.click(zone);
      }

      // Should handle all clicks without error
      expect(onClick).toHaveBeenCalledTimes(10);
    });

    it('should handle prop changes while focused', () => {
      const { rerender } = render(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={100}
        />
      );

      const zone = screen.getByTestId('transition-zone');
      zone.focus();

      // Change props while focused
      rerender(
        <TransitionZone
          clipA={mockClipA}
          clipB={mockClipB}
          zoom={200}
          transition={mockTransitionEffect}
        />
      );

      // Should still be rendered and functional
      expect(screen.getByTestId('transition-zone')).toBeInTheDocument();
    });
  });
});
