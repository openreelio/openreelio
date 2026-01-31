/**
 * Shortcut Utilities
 *
 * Utilities for parsing, building, and validating keyboard shortcut signatures.
 * Handles key signature normalization, platform-specific display, and comparison.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Parsed representation of a keyboard shortcut.
 */
export interface KeySignature {
  /** The main key (lowercase) */
  key: string;
  /** Ctrl/Control modifier */
  ctrl: boolean;
  /** Shift modifier */
  shift: boolean;
  /** Alt/Option modifier */
  alt: boolean;
  /** Meta/Cmd/Windows modifier */
  meta: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Keys that should be ignored (modifier-only presses) */
const MODIFIER_KEYS = new Set([
  'control',
  'shift',
  'alt',
  'meta',
  'altgraph',
]);

/** Valid special keys */
const VALID_SPECIAL_KEYS = new Set([
  'space',
  'enter',
  'escape',
  'tab',
  'delete',
  'backspace',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6',
  'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
]);

/** Display names for special keys */
const KEY_DISPLAY_NAMES: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  space: 'Space',
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  delete: 'Del',
  backspace: '⌫',
  insert: 'Ins',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
};

/** Platform-specific modifier symbols (Mac) */
const MAC_MODIFIER_SYMBOLS: Record<string, string> = {
  ctrl: '⌃',
  shift: '⇧',
  alt: '⌥',
  meta: '⌘',
};

// =============================================================================
// Parsing
// =============================================================================

/**
 * Parses a key signature string into its components.
 *
 * @param signature - Key signature like "Ctrl+Shift+S"
 * @returns Parsed signature or null if invalid
 */
export function parseKeySignature(signature: string): KeySignature | null {
  if (!signature || signature.trim() === '') {
    return null;
  }

  const parts = signature.split('+').map((p) => p.trim().toLowerCase());

  if (parts.length === 0 || parts.some((p) => p === '')) {
    return null;
  }

  // Last part is the key
  const key = parts[parts.length - 1];

  // Rest are modifiers
  const modifiers = new Set(parts.slice(0, -1));

  return {
    key,
    ctrl: modifiers.has('ctrl') || modifiers.has('control'),
    shift: modifiers.has('shift'),
    alt: modifiers.has('alt') || modifiers.has('option'),
    meta: modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('command'),
  };
}

/**
 * Builds a normalized key signature string from components.
 *
 * @param sig - Key signature components
 * @returns Normalized signature string like "Ctrl+Shift+S"
 */
export function buildKeySignature(sig: KeySignature): string {
  const parts: string[] = [];

  if (sig.ctrl) parts.push('Ctrl');
  if (sig.shift) parts.push('Shift');
  if (sig.alt) parts.push('Alt');
  if (sig.meta) parts.push('Meta');

  // Capitalize key
  const key = sig.key.charAt(0).toUpperCase() + sig.key.slice(1);
  parts.push(key);

  return parts.join('+');
}

/**
 * Normalizes a key signature to canonical form.
 * Ensures consistent modifier order and capitalization.
 *
 * @param signature - Key signature to normalize
 * @returns Normalized signature or empty string if invalid
 */
export function normalizeKeySignature(signature: string): string {
  const parsed = parseKeySignature(signature);
  if (!parsed) {
    return '';
  }
  return buildKeySignature(parsed);
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Checks if a key is a valid non-modifier key.
 */
function isValidKey(key: string): boolean {
  const lower = key.toLowerCase();

  // Single character (letter, number, symbol)
  if (lower.length === 1) {
    return true;
  }

  // Special keys
  if (VALID_SPECIAL_KEYS.has(lower)) {
    return true;
  }

  return false;
}

/**
 * Validates if a key signature is well-formed and represents a valid shortcut.
 *
 * @param signature - Key signature to validate
 * @returns True if valid
 */
export function isValidKeySignature(signature: string): boolean {
  const parsed = parseKeySignature(signature);
  if (!parsed) {
    return false;
  }

  return isValidKey(parsed.key);
}

// =============================================================================
// Event Conversion
// =============================================================================

/**
 * Converts a KeyboardEvent to a key signature string.
 *
 * @param event - The keyboard event
 * @returns Key signature string or empty string for modifier-only events
 */
export function keyEventToSignature(event: KeyboardEvent): string {
  const key = event.key.toLowerCase();

  // Ignore modifier-only key presses
  if (MODIFIER_KEYS.has(key)) {
    return '';
  }

  // Handle space key
  const normalizedKey = key === ' ' ? 'space' : key;

  const sig: KeySignature = {
    key: normalizedKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
  };

  return buildKeySignature(sig);
}

// =============================================================================
// Display
// =============================================================================

/**
 * Converts a key signature to a human-readable display string.
 *
 * @param signature - Key signature
 * @param usePlatformSymbols - Whether to use platform-specific symbols (Mac)
 * @returns Display string
 */
export function signatureToDisplayString(
  signature: string,
  usePlatformSymbols = false
): string {
  const parsed = parseKeySignature(signature);
  if (!parsed) {
    return signature;
  }

  const parts: string[] = [];

  if (usePlatformSymbols) {
    // Mac-style symbols
    if (parsed.ctrl) parts.push(MAC_MODIFIER_SYMBOLS.ctrl);
    if (parsed.shift) parts.push(MAC_MODIFIER_SYMBOLS.shift);
    if (parsed.alt) parts.push(MAC_MODIFIER_SYMBOLS.alt);
    if (parsed.meta) parts.push(MAC_MODIFIER_SYMBOLS.meta);
  } else {
    if (parsed.ctrl) parts.push('Ctrl');
    if (parsed.shift) parts.push('Shift');
    if (parsed.alt) parts.push('Alt');
    if (parsed.meta) parts.push('Meta');
  }

  // Get display name for key
  const keyLower = parsed.key.toLowerCase();
  const displayKey =
    KEY_DISPLAY_NAMES[keyLower] ??
    parsed.key.charAt(0).toUpperCase() + parsed.key.slice(1);
  parts.push(displayKey);

  return usePlatformSymbols ? parts.join('') : parts.join('+');
}

// =============================================================================
// Comparison
// =============================================================================

/**
 * Compares two key signatures for equality.
 * Handles different modifier orders and case variations.
 *
 * @param sig1 - First signature
 * @param sig2 - Second signature
 * @returns True if signatures represent the same shortcut
 */
export function compareSignatures(sig1: string, sig2: string): boolean {
  return normalizeKeySignature(sig1) === normalizeKeySignature(sig2);
}
