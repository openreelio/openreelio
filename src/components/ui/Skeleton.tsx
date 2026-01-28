/**
 * Skeleton Component
 *
 * Loading placeholder components for better UX during async operations.
 * Provides various preset shapes and compositions.
 *
 * @example
 * ```tsx
 * // Basic skeleton
 * <Skeleton className="w-full h-4" />
 *
 * // Text skeleton
 * <SkeletonText lines={3} />
 *
 * // Asset card skeleton
 * <SkeletonAssetCard />
 * ```
 */

import { memo, type HTMLAttributes } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** Whether to show animation */
  animate?: boolean;
}

export interface SkeletonTextProps {
  /** Number of lines to display */
  lines?: number;
  /** Whether last line should be shorter */
  lastLineShort?: boolean;
  /** Additional CSS classes */
  className?: string;
}

export interface SkeletonAssetCardProps {
  /** Whether to show metadata */
  showMetadata?: boolean;
  /** Additional CSS classes */
  className?: string;
}

// =============================================================================
// Base Skeleton Component
// =============================================================================

/**
 * Base skeleton component for loading states.
 * Uses a pulse animation to indicate content is loading.
 */
export function Skeleton({ className, animate = true, ...props }: SkeletonProps) {
  return (
    <div
      className={`${animate ? 'animate-pulse' : ''} rounded-md bg-editor-hover ${className ?? ''}`}
      {...props}
    />
  );
}

// =============================================================================
// Skeleton Text
// =============================================================================

/**
 * Text skeleton with multiple lines.
 */
export const SkeletonText = memo(function SkeletonText({
  lines = 3,
  lastLineShort = true,
  className = '',
}: SkeletonTextProps) {
  return (
    <div className={`space-y-2 ${className}`} data-testid="skeleton-text">
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          className={`h-4 ${
            lastLineShort && index === lines - 1 ? 'w-3/4' : 'w-full'
          }`}
        />
      ))}
    </div>
  );
});

// =============================================================================
// Skeleton Avatar
// =============================================================================

/**
 * Circular avatar skeleton.
 */
export const SkeletonAvatar = memo(function SkeletonAvatar({
  className = '',
  size = 'md',
}: {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizeClasses = {
    sm: 'w-8 h-8',
    md: 'w-10 h-10',
    lg: 'w-12 h-12',
  };

  return (
    <Skeleton
      className={`rounded-full ${sizeClasses[size]} ${className}`}
      data-testid="skeleton-avatar"
    />
  );
});

// =============================================================================
// Skeleton Card
// =============================================================================

/**
 * Card skeleton with title and description.
 */
export const SkeletonCard = memo(function SkeletonCard({
  className = '',
}: {
  className?: string;
}) {
  return (
    <div
      className={`p-4 border border-editor-border rounded-lg ${className}`}
      data-testid="skeleton-card"
    >
      <Skeleton className="h-6 w-3/4 mb-3" />
      <Skeleton className="h-4 w-full mb-2" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
});

// =============================================================================
// Skeleton Asset Card
// =============================================================================

/**
 * Asset card skeleton for project explorer.
 */
export const SkeletonAssetCard = memo(function SkeletonAssetCard({
  showMetadata = true,
  className = '',
}: SkeletonAssetCardProps) {
  return (
    <div
      className={`flex flex-col gap-2 p-2 ${className}`}
      data-testid="skeleton-asset-card"
    >
      {/* Thumbnail */}
      <Skeleton className="w-full aspect-video rounded" />

      {/* Filename */}
      <Skeleton className="h-4 w-3/4" />

      {/* Metadata */}
      {showMetadata && (
        <div className="flex gap-2">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 w-16" />
        </div>
      )}
    </div>
  );
});

// =============================================================================
// Skeleton Timeline Track
// =============================================================================

/**
 * Timeline track skeleton.
 */
export const SkeletonTimelineTrack = memo(function SkeletonTimelineTrack({
  className = '',
}: {
  className?: string;
}) {
  return (
    <div
      className={`flex items-center gap-2 h-16 px-2 border-b border-editor-border ${className}`}
      data-testid="skeleton-timeline-track"
    >
      {/* Track header */}
      <div className="w-24 flex flex-col gap-1 shrink-0">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-3 w-10" />
      </div>

      {/* Clips */}
      <div className="flex-1 flex gap-1">
        <Skeleton className="h-12 w-32 rounded" />
        <Skeleton className="h-12 w-48 rounded" />
        <Skeleton className="h-12 w-24 rounded" />
      </div>
    </div>
  );
});

// =============================================================================
// Skeleton Inspector
// =============================================================================

/**
 * Inspector panel skeleton.
 */
export const SkeletonInspector = memo(function SkeletonInspector({
  className = '',
}: {
  className?: string;
}) {
  return (
    <div className={`p-4 space-y-4 ${className}`} data-testid="skeleton-inspector">
      {/* Section header */}
      <Skeleton className="h-5 w-24" />

      {/* Properties */}
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={`prop-${index}`} className="flex items-center justify-between">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-32 rounded" />
        </div>
      ))}

      {/* Section header */}
      <Skeleton className="h-5 w-20 mt-4" />

      {/* More properties */}
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={`prop2-${index}`} className="flex items-center justify-between">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-8 w-24 rounded" />
        </div>
      ))}
    </div>
  );
});

// =============================================================================
// Skeleton Preview
// =============================================================================

/**
 * Preview player skeleton.
 */
export const SkeletonPreview = memo(function SkeletonPreview({
  className = '',
}: {
  className?: string;
}) {
  return (
    <div className={`flex flex-col h-full ${className}`} data-testid="skeleton-preview">
      {/* Video area */}
      <div className="flex-1 flex items-center justify-center bg-black/50">
        <Skeleton className="w-3/4 aspect-video" animate={false} />
      </div>

      {/* Controls */}
      <div className="h-12 flex items-center gap-2 px-4 border-t border-editor-border">
        <Skeleton className="h-8 w-8 rounded" />
        <Skeleton className="h-8 w-8 rounded" />
        <Skeleton className="h-8 w-8 rounded" />
        <Skeleton className="flex-1 h-2 rounded-full" />
        <Skeleton className="h-4 w-16" />
      </div>
    </div>
  );
});

// =============================================================================
// Skeleton List Item
// =============================================================================

/**
 * List item skeleton.
 */
export const SkeletonListItem = memo(function SkeletonListItem({
  hasIcon = true,
  className = '',
}: {
  hasIcon?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center gap-3 p-2 ${className}`}
      data-testid="skeleton-list-item"
    >
      {hasIcon && <Skeleton className="w-8 h-8 rounded" />}
      <div className="flex-1 space-y-1">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
});

// =============================================================================
// Exports
// =============================================================================

export default Skeleton;
