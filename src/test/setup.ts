/**
 * Vitest Setup File
 *
 * Configures test environment with mocks and global utilities.
 */

import { vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';

// =============================================================================
// Tauri API Mocks
// =============================================================================

// Mock @tauri-apps/api/core invoke function
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock @tauri-apps/api/event for event listeners
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
}));

// =============================================================================
// Global Test Utilities
// =============================================================================

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Clean up after each test
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Ensure real timers are restored to prevent timer-related hangs
  vi.useRealTimers();
});

// =============================================================================
// DOM Environment Setup
// =============================================================================

// Mock canvas APIs for jsdom (avoids noisy "Not implemented: getContext" errors)
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  writable: true,
  value: vi.fn(() => {
    return {
      // minimal 2D context surface used by our components
      fillStyle: '#000000',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
  }),
});

// Ensure window.matchMedia is available for responsive tests
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver for component tests
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(_callback: ResizeObserverCallback) {
    void _callback;
    // Store callback if needed for testing
  }
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Mock IntersectionObserver for lazy loading tests
class MockIntersectionObserver {
  readonly root: Element | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [];

  observe = vi.fn((target: Element) => {
    // Immediately trigger intersection for testing (simulate element being visible)
    const entry: IntersectionObserverEntry = {
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRatio: 1,
      intersectionRect: target.getBoundingClientRect(),
      isIntersecting: true,
      rootBounds: null,
      target,
      time: Date.now(),
    };
    this.callback([entry], this as unknown as IntersectionObserver);
  });
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);

  private callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {
    void _options;
    this.callback = callback;
  }
}
global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
