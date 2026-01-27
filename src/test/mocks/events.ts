/**
 * Event Mock Factories
 *
 * Provides mock factories for DOM events used in testing.
 * Includes drag events, mouse events, and keyboard events.
 */

import { vi } from 'vitest';

// =============================================================================
// Mouse Event Mocks
// =============================================================================

/**
 * Options for creating a mock mouse event.
 */
export interface MockMouseEventOptions {
  clientX?: number;
  clientY?: number;
  button?: number;
  buttons?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/**
 * Creates a mock MouseEvent for testing.
 *
 * @param type - Event type (mousedown, mousemove, mouseup, click)
 * @param options - Event options
 * @returns MouseEvent instance
 *
 * @example
 * const event = createMockMouseEvent('mousedown', { clientX: 100, clientY: 50 });
 */
export function createMockMouseEvent(
  type: 'mousedown' | 'mousemove' | 'mouseup' | 'click' | 'dblclick',
  options: MockMouseEventOptions = {},
): MouseEvent {
  const {
    clientX = 0,
    clientY = 0,
    button = 0,
    buttons = type === 'mousemove' ? 1 : 0,
    ctrlKey = false,
    shiftKey = false,
    altKey = false,
    metaKey = false,
  } = options;

  return new MouseEvent(type, {
    clientX,
    clientY,
    button,
    buttons,
    ctrlKey,
    shiftKey,
    altKey,
    metaKey,
    bubbles: true,
    cancelable: true,
  });
}

// =============================================================================
// Drag Event Mocks
// =============================================================================

/**
 * Options for creating a mock drag event.
 */
export interface MockDragEventOptions {
  clientX?: number;
  clientY?: number;
  dataTransferData?: Record<string, string>;
  dataTransferTypes?: string[];
  currentTarget?: HTMLElement;
  dropEffect?: DataTransfer['dropEffect'];
}

/**
 * Creates a mock React DragEvent for testing.
 *
 * @param type - Event type (dragenter, dragover, dragleave, drop)
 * @param options - Event options
 * @returns Mock DragEvent that matches React.DragEvent interface
 *
 * @example
 * const event = createMockDragEvent('drop', {
 *   dataTransferData: { 'application/json': JSON.stringify({ id: 'asset-1' }) },
 * });
 */
export function createMockDragEvent(
  type: 'dragstart' | 'dragenter' | 'dragover' | 'dragleave' | 'drop' | 'dragend',
  options: MockDragEventOptions = {},
): React.DragEvent {
  const {
    clientX = 300,
    clientY = 50,
    dataTransferData = { 'application/json': JSON.stringify({ id: 'asset-1' }) },
    dataTransferTypes = Object.keys(dataTransferData),
    currentTarget = createMockElement(),
    dropEffect = 'none',
  } = options;

  return {
    type,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clientX,
    clientY,
    currentTarget,
    target: currentTarget,
    dataTransfer: {
      types: dataTransferTypes,
      getData: (format: string) => dataTransferData[format] || '',
      setData: vi.fn(),
      clearData: vi.fn(),
      dropEffect,
      effectAllowed: 'all',
      files: [] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      setDragImage: vi.fn(),
    },
    nativeEvent: new DragEvent(type),
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    eventPhase: 0,
    isTrusted: true,
    timeStamp: Date.now(),
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false,
    persist: vi.fn(),
  } as unknown as React.DragEvent;
}

// =============================================================================
// Keyboard Event Mocks
// =============================================================================

/**
 * Options for creating a mock keyboard event.
 */
export interface MockKeyboardEventOptions {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
}

/**
 * Creates a mock KeyboardEvent for testing.
 *
 * @param type - Event type (keydown, keyup, keypress)
 * @param options - Event options
 * @returns KeyboardEvent instance
 *
 * @example
 * const event = createMockKeyboardEvent('keydown', { key: 'Enter', ctrlKey: true });
 */
export function createMockKeyboardEvent(
  type: 'keydown' | 'keyup' | 'keypress',
  options: MockKeyboardEventOptions = {},
): KeyboardEvent {
  const {
    key = '',
    code = '',
    ctrlKey = false,
    shiftKey = false,
    altKey = false,
    metaKey = false,
    repeat = false,
  } = options;

  return new KeyboardEvent(type, {
    key,
    code,
    ctrlKey,
    shiftKey,
    altKey,
    metaKey,
    repeat,
    bubbles: true,
    cancelable: true,
  });
}

// =============================================================================
// Wheel Event Mocks
// =============================================================================

/**
 * Options for creating a mock wheel event.
 */
export interface MockWheelEventOptions {
  deltaX?: number;
  deltaY?: number;
  deltaZ?: number;
  deltaMode?: number;
  clientX?: number;
  clientY?: number;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Creates a mock WheelEvent for testing.
 *
 * @param options - Event options
 * @returns WheelEvent instance
 */
export function createMockWheelEvent(options: MockWheelEventOptions = {}): WheelEvent {
  const {
    deltaX = 0,
    deltaY = 0,
    deltaZ = 0,
    deltaMode = 0,
    clientX = 0,
    clientY = 0,
    ctrlKey = false,
    shiftKey = false,
  } = options;

  return new WheelEvent('wheel', {
    deltaX,
    deltaY,
    deltaZ,
    deltaMode,
    clientX,
    clientY,
    ctrlKey,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
}

// =============================================================================
// DOM Element Mocks
// =============================================================================

/**
 * Options for creating a mock DOM element.
 */
export interface MockElementOptions {
  tagName?: string;
  boundingRect?: Partial<DOMRect>;
  classList?: string[];
}

/**
 * Creates a mock HTML element with getBoundingClientRect.
 *
 * @param options - Element options
 * @returns HTMLElement with mocked methods
 */
export function createMockElement(options: MockElementOptions = {}): HTMLElement {
  const {
    tagName = 'div',
    boundingRect = {},
    classList = [],
  } = options;

  const element = document.createElement(tagName);

  // Add classes
  classList.forEach((cls) => element.classList.add(cls));

  // Mock getBoundingClientRect
  const rect: DOMRect = {
    left: 100,
    top: 0,
    right: 900,
    bottom: 200,
    width: 800,
    height: 200,
    x: 100,
    y: 0,
    ...boundingRect,
    toJSON: () => ({}),
  };

  element.getBoundingClientRect = vi.fn().mockReturnValue(rect);

  return element;
}

// =============================================================================
// Event Listener Mock Helpers
// =============================================================================

/**
 * Creates a mock for Tauri's listen function.
 * Returns a cleanup function that does nothing.
 */
export function createMockTauriListen() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return vi.fn((_event: string, _callback: unknown) => {
    return Promise.resolve(() => {});
  });
}

/**
 * Creates a map-based event listener mock that allows triggering events.
 *
 * @returns Object with listen mock and emit function
 *
 * @example
 * const { listen, emit } = createMockEventEmitter();
 * vi.mock('@tauri-apps/api/event', () => ({ listen }));
 * // Later in test:
 * emit('job:progress', { jobId: '1', progress: 50 });
 */
export function createMockEventEmitter<T = unknown>() {
  const listeners = new Map<string, Set<(event: { payload: T }) => void>>();

  const listen = vi.fn((event: string, callback: (event: { payload: T }) => void) => {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    listeners.get(event)!.add(callback);

    return Promise.resolve(() => {
      listeners.get(event)?.delete(callback);
    });
  });

  const emit = (event: string, payload: T) => {
    const eventListeners = listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach((callback) => callback({ payload }));
    }
  };

  const clear = () => {
    listeners.clear();
  };

  return { listen, emit, clear };
}
