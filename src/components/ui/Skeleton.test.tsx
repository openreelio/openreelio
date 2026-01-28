/**
 * Skeleton Component Tests
 *
 * Comprehensive tests for skeleton loading components.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Skeleton,
  SkeletonText,
  SkeletonAvatar,
  SkeletonCard,
  SkeletonAssetCard,
  SkeletonTimelineTrack,
  SkeletonInspector,
  SkeletonPreview,
  SkeletonListItem,
} from './Skeleton';

describe('Skeleton', () => {
  // ===========================================================================
  // Base Skeleton
  // ===========================================================================

  describe('Base Skeleton', () => {
    it('renders with default base classes', () => {
      render(<Skeleton data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');

      expect(skeleton).toBeInTheDocument();
      expect(skeleton).toHaveClass('animate-pulse');
      expect(skeleton).toHaveClass('rounded-md');
      // Note: bg-editor-hover is a Tailwind custom class defined in the project's theme
      expect(skeleton.className).toMatch(/bg-editor-hover/);
    });

    it('merges custom classNames', () => {
      render(<Skeleton className="w-20 h-20 rounded-full" data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');

      expect(skeleton).toHaveClass('w-20');
      expect(skeleton).toHaveClass('h-20');
      expect(skeleton).toHaveClass('rounded-full');
      expect(skeleton).toHaveClass('animate-pulse');
    });

    it('can disable animation', () => {
      render(<Skeleton animate={false} data-testid="skeleton" />);
      const skeleton = screen.getByTestId('skeleton');

      expect(skeleton).not.toHaveClass('animate-pulse');
    });
  });

  // ===========================================================================
  // SkeletonText
  // ===========================================================================

  describe('SkeletonText', () => {
    it('renders default 3 lines', () => {
      render(<SkeletonText />);
      const container = screen.getByTestId('skeleton-text');
      const lines = container.querySelectorAll('.animate-pulse');

      expect(lines).toHaveLength(3);
    });

    it('renders specified number of lines', () => {
      render(<SkeletonText lines={5} />);
      const container = screen.getByTestId('skeleton-text');
      const lines = container.querySelectorAll('.animate-pulse');

      expect(lines).toHaveLength(5);
    });

    it('makes last line shorter by default', () => {
      render(<SkeletonText lines={2} />);
      const container = screen.getByTestId('skeleton-text');
      const lines = container.querySelectorAll('.animate-pulse');

      expect(lines[0]).toHaveClass('w-full');
      expect(lines[1]).toHaveClass('w-3/4');
    });

    it('can make all lines full width', () => {
      render(<SkeletonText lines={2} lastLineShort={false} />);
      const container = screen.getByTestId('skeleton-text');
      const lines = container.querySelectorAll('.animate-pulse');

      expect(lines[0]).toHaveClass('w-full');
      expect(lines[1]).toHaveClass('w-full');
    });
  });

  // ===========================================================================
  // SkeletonAvatar
  // ===========================================================================

  describe('SkeletonAvatar', () => {
    it('renders circular skeleton', () => {
      render(<SkeletonAvatar />);
      const avatar = screen.getByTestId('skeleton-avatar');

      expect(avatar).toHaveClass('rounded-full');
    });

    it('renders medium size by default', () => {
      render(<SkeletonAvatar />);
      const avatar = screen.getByTestId('skeleton-avatar');

      expect(avatar).toHaveClass('w-10');
      expect(avatar).toHaveClass('h-10');
    });

    it('renders small size', () => {
      render(<SkeletonAvatar size="sm" />);
      const avatar = screen.getByTestId('skeleton-avatar');

      expect(avatar).toHaveClass('w-8');
      expect(avatar).toHaveClass('h-8');
    });

    it('renders large size', () => {
      render(<SkeletonAvatar size="lg" />);
      const avatar = screen.getByTestId('skeleton-avatar');

      expect(avatar).toHaveClass('w-12');
      expect(avatar).toHaveClass('h-12');
    });
  });

  // ===========================================================================
  // SkeletonCard
  // ===========================================================================

  describe('SkeletonCard', () => {
    it('renders card structure', () => {
      render(<SkeletonCard />);
      const card = screen.getByTestId('skeleton-card');

      expect(card).toBeInTheDocument();
      expect(card).toHaveClass('p-4');
      expect(card).toHaveClass('border');
      expect(card).toHaveClass('rounded-lg');
    });

    it('renders title and description skeletons', () => {
      render(<SkeletonCard />);
      const card = screen.getByTestId('skeleton-card');
      const skeletons = card.querySelectorAll('.animate-pulse');

      expect(skeletons.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ===========================================================================
  // SkeletonAssetCard
  // ===========================================================================

  describe('SkeletonAssetCard', () => {
    it('renders asset card structure', () => {
      render(<SkeletonAssetCard />);
      const card = screen.getByTestId('skeleton-asset-card');

      expect(card).toBeInTheDocument();
    });

    it('renders thumbnail skeleton', () => {
      render(<SkeletonAssetCard />);
      const card = screen.getByTestId('skeleton-asset-card');
      const thumbnail = card.querySelector('.aspect-video');

      expect(thumbnail).toBeInTheDocument();
    });

    it('renders metadata by default', () => {
      render(<SkeletonAssetCard />);
      const card = screen.getByTestId('skeleton-asset-card');
      const skeletons = card.querySelectorAll('.animate-pulse');

      expect(skeletons.length).toBeGreaterThanOrEqual(3);
    });

    it('can hide metadata', () => {
      render(<SkeletonAssetCard showMetadata={false} />);
      const card = screen.getByTestId('skeleton-asset-card');
      const skeletons = card.querySelectorAll('.animate-pulse');

      // Should have fewer skeletons without metadata
      expect(skeletons.length).toBe(2); // thumbnail + filename only
    });
  });

  // ===========================================================================
  // SkeletonTimelineTrack
  // ===========================================================================

  describe('SkeletonTimelineTrack', () => {
    it('renders timeline track structure', () => {
      render(<SkeletonTimelineTrack />);
      const track = screen.getByTestId('skeleton-timeline-track');

      expect(track).toBeInTheDocument();
      expect(track).toHaveClass('h-16');
    });

    it('renders track header and clips', () => {
      render(<SkeletonTimelineTrack />);
      const track = screen.getByTestId('skeleton-timeline-track');
      const skeletons = track.querySelectorAll('.animate-pulse');

      // Should have header skeletons + clip skeletons
      expect(skeletons.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ===========================================================================
  // SkeletonInspector
  // ===========================================================================

  describe('SkeletonInspector', () => {
    it('renders inspector structure', () => {
      render(<SkeletonInspector />);
      const inspector = screen.getByTestId('skeleton-inspector');

      expect(inspector).toBeInTheDocument();
      expect(inspector).toHaveClass('p-4');
    });

    it('renders multiple property rows', () => {
      render(<SkeletonInspector />);
      const inspector = screen.getByTestId('skeleton-inspector');
      const skeletons = inspector.querySelectorAll('.animate-pulse');

      // Should have many property skeletons
      expect(skeletons.length).toBeGreaterThanOrEqual(10);
    });
  });

  // ===========================================================================
  // SkeletonPreview
  // ===========================================================================

  describe('SkeletonPreview', () => {
    it('renders preview structure', () => {
      render(<SkeletonPreview />);
      const preview = screen.getByTestId('skeleton-preview');

      expect(preview).toBeInTheDocument();
      expect(preview).toHaveClass('flex-col');
    });

    it('renders video area and controls', () => {
      render(<SkeletonPreview />);
      const preview = screen.getByTestId('skeleton-preview');

      // Video area (aspect-video)
      const videoArea = preview.querySelector('.aspect-video');
      expect(videoArea).toBeInTheDocument();

      // Controls area
      const controls = preview.querySelector('.h-12');
      expect(controls).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // SkeletonListItem
  // ===========================================================================

  describe('SkeletonListItem', () => {
    it('renders list item structure', () => {
      render(<SkeletonListItem />);
      const item = screen.getByTestId('skeleton-list-item');

      expect(item).toBeInTheDocument();
      expect(item).toHaveClass('flex');
      expect(item).toHaveClass('items-center');
    });

    it('renders icon by default', () => {
      render(<SkeletonListItem />);
      const item = screen.getByTestId('skeleton-list-item');
      const icon = item.querySelector('.w-8.h-8');

      expect(icon).toBeInTheDocument();
    });

    it('can hide icon', () => {
      render(<SkeletonListItem hasIcon={false} />);
      const item = screen.getByTestId('skeleton-list-item');
      const icon = item.querySelector('.w-8.h-8');

      expect(icon).not.toBeInTheDocument();
    });
  });
});
