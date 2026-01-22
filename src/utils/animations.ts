/**
 * Animation Utilities
 *
 * Centralized animation configuration following professional NLE design patterns.
 */

// =============================================================================
// Transition Configurations
// =============================================================================

export const transitions = {
  button: {
    hover: 'background-color 150ms var(--ease-out)',
    press: 'transform 100ms ease-in',
  },
  panel: {
    collapse: 'height 200ms var(--ease-out)',
    expand: 'height 200ms var(--ease-out)',
  },
  modal: {
    enter: 'opacity 200ms var(--ease-out), transform 250ms var(--ease-spring)',
    exit: 'opacity 150ms ease-in, transform 200ms ease-in',
  },
  toast: {
    enter: 'transform 200ms var(--ease-out), opacity 150ms var(--ease-out)',
    exit: 'transform 150ms ease-in, opacity 100ms ease-in',
  },
  clip: {
    select: 'box-shadow 100ms var(--ease-out)',
    drag: 'none', // Immediate for drag operations
  },
  snap: {
    appear: 'opacity 50ms linear',
  },
} as const;

// =============================================================================
// Duration Tokens
// =============================================================================

export const durations = {
  instant: 50,   // 50ms - Snap indicators
  fast: 100,     // 100ms - Clip selection
  normal: 200,   // 200ms - Panel collapse, modals
  slow: 300,     // 300ms - Complex transitions
} as const;

// =============================================================================
// Easing Functions
// =============================================================================

export const easings = {
  linear: 'linear',
  easeOut: 'cubic-bezier(0, 0, 0.2, 1)',
  easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
  spring: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
} as const;

// =============================================================================
// Spring Configurations (for libraries like framer-motion)
// =============================================================================

export const springConfig = {
  button: { stiffness: 520, damping: 32 },
  panel: { stiffness: 300, damping: 25 },
  drag: { stiffness: 400, damping: 30 },
  modal: { stiffness: 350, damping: 28 },
} as const;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get transition CSS string
 */
export function getTransition(type: keyof typeof transitions, variant: string): string {
  const config = transitions[type];
  if (config && variant in config) {
    return config[variant as keyof typeof config];
  }
  return 'all 200ms var(--ease-out)';
}

/**
 * Create custom transition string
 */
export function createTransition(
  properties: string[],
  duration: number = durations.normal,
  easing: string = easings.easeOut
): string {
  return properties.map((prop) => `${prop} ${duration}ms ${easing}`).join(', ');
}

/**
 * Check if user prefers reduced motion
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Get safe animation duration (respects reduced motion preference)
 */
export function getSafeDuration(duration: number): number {
  return prefersReducedMotion() ? 1 : duration;
}
