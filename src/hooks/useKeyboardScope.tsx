/**
 * useKeyboardScope Hook
 *
 * Provides z-index aware keyboard shortcut handling.
 * Only the scope with the highest z-index receives keyboard events.
 *
 * Based on Remotion's keybinding system pattern.
 *
 * Features:
 * - Hierarchical scoped shortcuts with z-index context
 * - Pane-based lifecycle management
 * - Input field exclusion options
 *
 * @module hooks/useKeyboardScope
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

// =============================================================================
// Types
// =============================================================================

export type ShortcutHandler = () => void;

export interface ShortcutOptions {
  /** Allow shortcuts when focus is in input/textarea/contenteditable */
  allowInInputs?: boolean;
  /** Enable/disable the scope */
  enabled?: boolean;
}

/**
 * Common scope priority presets.
 *
 * Higher values win when multiple scopes are registered.
 */
export const SCOPE_PRIORITY = {
  GLOBAL: 10,
  PANEL: 50,
  MODAL: 100,
  DIALOG: 200,
  CRITICAL: 300,
} as const;

export type ScopePriorityLevel = number;

/**
 * A keyboard scope with shortcuts and z-index
 */
export interface KeyboardScope {
  /** Unique identifier for the scope */
  id: string;
  /** Z-index determines priority (higher = active) */
  zIndex: number;
  /** Map of key signatures to handler functions */
  shortcuts: Map<string, ShortcutHandler>;
  /** Whether to allow shortcuts in input fields */
  allowInInputs?: boolean;
  /** Whether the scope is enabled */
  enabled?: boolean;
}

/**
 * Options for useScopedShortcuts hook
 */
export type ScopedShortcutsOptions = ShortcutOptions;

/**
 * Context value for keyboard scope
 */
export interface KeyboardScopeContextValue {
  /** Register a keyboard scope */
  registerScope: (scope: KeyboardScope) => void;
  /** Unregister a keyboard scope by ID */
  unregisterScope: (scopeId: string) => void;
  /** Get the currently active scope (highest z-index) */
  getActiveScope: () => KeyboardScope | null;
  /** Force re-render (for testing) */
  _forceUpdate: () => void;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Build a normalized key signature from a keyboard event
 *
 * @param event - The keyboard event
 * @returns Normalized key signature (e.g., "mod+shift+s")
 */
export function buildKeySignature(event: KeyboardEvent): string {
  const parts: string[] = [];

  // Normalize ctrl/meta to "mod" for cross-platform support
  if (event.ctrlKey || event.metaKey) {
    parts.push('mod');
  }
  if (event.shiftKey) {
    parts.push('shift');
  }
  if (event.altKey) {
    parts.push('alt');
  }

  // Handle special keys
  let key = event.key.toLowerCase();
  if (key === ' ') {
    key = 'space';
  }

  parts.push(key);

  return parts.join('+');
}

/**
 * Check if the event target is an input-like element
 */
function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toUpperCase();
  if (tagName === 'INPUT' || tagName === 'TEXTAREA') {
    return true;
  }

  if (target.isContentEditable) {
    return true;
  }

  return false;
}

// =============================================================================
// Context
// =============================================================================

const KeyboardScopeContext = createContext<KeyboardScopeContextValue | null>(null);

// =============================================================================
// Provider Component
// =============================================================================

/**
 * Provider for keyboard scope context
 *
 * Manages all registered keyboard scopes and dispatches events
 * to the scope with the highest z-index.
 */
export function KeyboardScopeProvider({ children }: { children: ReactNode }) {
  const scopesRef = useRef<Map<string, KeyboardScope>>(new Map());
  const [, setUpdateCounter] = useState(0);

  const forceUpdate = useCallback(() => {
    setUpdateCounter((c) => c + 1);
  }, []);

  const registerScope = useCallback((scope: KeyboardScope) => {
    scopesRef.current.set(scope.id, scope);
    forceUpdate();
  }, [forceUpdate]);

  const unregisterScope = useCallback((scopeId: string) => {
    scopesRef.current.delete(scopeId);
    forceUpdate();
  }, [forceUpdate]);

  const getActiveScope = useCallback((): KeyboardScope | null => {
    let highest: KeyboardScope | null = null;

    for (const scope of scopesRef.current.values()) {
      // Skip disabled scopes
      if (scope.enabled === false) {
        continue;
      }

      if (!highest || scope.zIndex > highest.zIndex) {
        highest = scope;
      }
    }

    return highest;
  }, []);

  // Global keyboard event handler
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const activeScope = getActiveScope();
      if (!activeScope) {
        return;
      }

      // Check if we should skip input elements
      if (!activeScope.allowInInputs && isInputElement(event.target)) {
        return;
      }

      const signature = buildKeySignature(event);
      const handler = activeScope.shortcuts.get(signature);

      if (handler) {
        event.preventDefault();
        handler();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [getActiveScope]);

  const contextValue: KeyboardScopeContextValue = useMemo(
    () => ({
      registerScope,
      unregisterScope,
      getActiveScope,
      _forceUpdate: forceUpdate,
    }),
    [forceUpdate, getActiveScope, registerScope, unregisterScope]
  );

  return (
    <KeyboardScopeContext.Provider value={contextValue}>
      {children}
    </KeyboardScopeContext.Provider>
  );
}

// =============================================================================
// Hooks
// =============================================================================

/**
 * Access the keyboard scope context
 *
 * @throws Error if used outside KeyboardScopeProvider
 */
export function useKeyboardScope(): KeyboardScopeContextValue {
  const context = useContext(KeyboardScopeContext);

  if (!context) {
    throw new Error('useKeyboardScope must be used within a KeyboardScopeProvider');
  }

  return context;
}

/**
 * Register scoped keyboard shortcuts
 *
 * @param scopeId - Unique identifier for this scope
 * @param zIndex - Priority level (higher = active when multiple scopes exist)
 * @param shortcuts - Map of key signatures to handlers
 * @param options - Additional options
 *
 * @example
 * ```tsx
 * // In a modal component (high z-index)
 * useScopedShortcuts('modal', 100, {
 *   'escape': () => closeModal(),
 *   'mod+enter': () => submitForm(),
 * });
 *
 * // In the main editor (lower z-index)
 * useScopedShortcuts('editor', 50, {
 *   'mod+s': () => save(),
 *   'mod+z': () => undo(),
 * });
 * ```
 */
export function useScopedShortcuts(
  scopeId: string,
  zIndex: number,
  shortcuts: Record<string, ShortcutHandler>,
  options: ScopedShortcutsOptions = {}
): void {
  const context = useContext(KeyboardScopeContext);
  const { allowInInputs = false, enabled = true } = options;

  useEffect(() => {
    if (!context) {
      return;
    }

    const scope: KeyboardScope = {
      id: scopeId,
      zIndex,
      shortcuts: new Map(Object.entries(shortcuts)),
      allowInInputs,
      enabled,
    };

    context.registerScope(scope);

    return () => {
      context.unregisterScope(scopeId);
    };
  }, [context, scopeId, zIndex, shortcuts, allowInInputs, enabled]);
}

/**
 * Register shortcuts under a scope id and priority.
 *
 * This is a naming alias used throughout the app.
 */
export function useRegisterShortcuts(
  scopeId: string,
  priority: ScopePriorityLevel,
  shortcuts: Record<string, ShortcutHandler>,
  options: ShortcutOptions = {}
): void {
  useScopedShortcuts(scopeId, priority, shortcuts, options);
}

/**
 * Returns the currently active scope id.
 */
export function useCurrentScopeId(): string | null {
  const context = useContext(KeyboardScopeContext);
  return context?.getActiveScope()?.id ?? null;
}

/**
 * Returns whether shortcuts are active (optionally for a specific scope).
 */
export function useIsShortcutsActive(scopeId?: string): boolean {
  const activeId = useCurrentScopeId();
  if (!activeId) return false;
  if (!scopeId) return true;
  return activeId === scopeId;
}

/**
 * Provides an element-level keydown handler that respects the active scope.
 *
 * Note: The provider already installs a global listener. This handler is useful
 * for focused widgets (e.g. listboxes) that want to handle keys locally while
 * still honoring scope priority.
 */
export function useScopedKeyHandler(
  scopeId: string,
  shortcuts: Record<string, ShortcutHandler>,
  options: ShortcutOptions = {}
): (event: ReactKeyboardEvent) => void {
  const context = useContext(KeyboardScopeContext);
  const { allowInInputs = false, enabled = true } = options;

  return useCallback(
    (event: ReactKeyboardEvent) => {
      if (!enabled) return;
      if (!context) return;

      const activeScope = context.getActiveScope();
      if (!activeScope || activeScope.id !== scopeId) {
        return;
      }

      if (!allowInInputs && isInputElement(event.target)) {
        return;
      }

      const signature = buildKeySignature(event.nativeEvent);
      const handler = shortcuts[signature];
      if (handler) {
        event.preventDefault();
        handler();
      }
    },
    [allowInInputs, context, enabled, scopeId, shortcuts]
  );
}

/**
 * Get all registered scopes (for debugging)
 */
export function useAllScopes(): KeyboardScope[] {
  const context = useContext(KeyboardScopeContext);

  if (!context) {
    return [];
  }

  // This is a hack to get all scopes for debugging
  // In production, you shouldn't need this
  const scopes: KeyboardScope[] = [];
  const activeScope = context.getActiveScope();
  if (activeScope) {
    scopes.push(activeScope);
  }

  return scopes;
}

export default useKeyboardScope;
