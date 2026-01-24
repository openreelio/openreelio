import type { HTMLAttributes } from 'react';

/**
 * Skeleton component for loading states.
 * Uses a pulse animation to indicate content is loading.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`animate-pulse rounded-md bg-gray-700 ${className || ''}`} {...props} />;
}
