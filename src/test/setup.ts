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

// Provide PointerEvent support for jsdom-based tests.
// Vitest + jsdom environments may not expose PointerEvent, which causes
// fireEvent.pointer* payload fields (clientX, pointerId) to be dropped.
if (typeof window.PointerEvent === 'undefined') {
  class MockPointerEvent extends MouseEvent implements PointerEvent {
    readonly pointerId: number;
    readonly width: number;
    readonly height: number;
    readonly pressure: number;
    readonly tangentialPressure: number;
    readonly tiltX: number;
    readonly tiltY: number;
    readonly twist: number;
    readonly altitudeAngle: number;
    readonly azimuthAngle: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);

      this.pointerId = params.pointerId ?? 1;
      this.width = params.width ?? 1;
      this.height = params.height ?? 1;
      this.pressure = params.pressure ?? 0;
      this.tangentialPressure = params.tangentialPressure ?? 0;
      this.tiltX = params.tiltX ?? 0;
      this.tiltY = params.tiltY ?? 0;
      this.twist = params.twist ?? 0;
      this.altitudeAngle = 0;
      this.azimuthAngle = 0;
      this.pointerType = params.pointerType ?? 'mouse';
      this.isPrimary = params.isPrimary ?? true;
    }

    getCoalescedEvents(): PointerEvent[] {
      return [];
    }

    getPredictedEvents(): PointerEvent[] {
      return [];
    }
  }

  Object.defineProperty(window, 'PointerEvent', {
    writable: true,
    configurable: true,
    value: MockPointerEvent,
  });
  Object.defineProperty(globalThis, 'PointerEvent', {
    writable: true,
    configurable: true,
    value: MockPointerEvent,
  });
}

if (typeof HTMLElement.prototype.setPointerCapture !== 'function') {
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    writable: true,
    value: () => {},
  });
}

if (typeof HTMLElement.prototype.releasePointerCapture !== 'function') {
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    writable: true,
    value: () => {},
  });
}

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
