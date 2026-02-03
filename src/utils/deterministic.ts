/**
 * Deterministic Utilities
 *
 * Provides deterministic random generation for reproducible results.
 * Essential for AI-driven video generation where the same input
 * should always produce the same output.
 *
 * Based on AI_AUTOMATION_ROADMAP.md Phase 6.
 *
 * @module utils/deterministic
 */

// =============================================================================
// Seeded Random Number Generator
// =============================================================================

/**
 * Simple seeded PRNG using mulberry32 algorithm.
 * Fast, good quality, and produces consistent results across platforms.
 */
function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Convert string seed to numeric seed using simple hash.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Create a seeded random number generator.
 * Same seed always produces same sequence.
 *
 * @param seed - String seed for reproducibility
 * @returns Function that returns random numbers between 0 and 1
 *
 * @example
 * ```ts
 * const random = seededRandom('my-project-123');
 * console.log(random()); // Always same value for same seed
 * console.log(random()); // Next value in sequence
 * ```
 */
export function seededRandom(seed: string): () => number {
  const numericSeed = hashString(seed);
  return mulberry32(numericSeed);
}

/**
 * Generate deterministic UUID from seed and index.
 * Same seed and index always produce same UUID.
 *
 * @param seed - Base seed string
 * @param index - Index for generating unique UUIDs from same seed
 * @returns UUID v4 format string
 *
 * @example
 * ```ts
 * const id1 = deterministicUUID('batch-job', 0); // First item
 * const id2 = deterministicUUID('batch-job', 1); // Second item
 * // Same IDs every time for same seed+index
 * ```
 */
export function deterministicUUID(seed: string, index: number): string {
  const rng = seededRandom(`${seed}-${index}`);

  // Generate 16 random bytes
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) {
    bytes.push(Math.floor(rng() * 256));
  }

  // Set version 4 (random) in byte 6
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Set variant (RFC 4122) in byte 8
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  // Convert to hex string with dashes
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Generate deterministic HSL color from seed.
 *
 * @param seed - Seed string
 * @returns HSL color string (e.g., "hsl(180, 60%, 50%)")
 *
 * @example
 * ```ts
 * const color = seededColor('track-1'); // Same color every time
 * element.style.backgroundColor = color;
 * ```
 */
export function seededColor(seed: string): string {
  const rng = seededRandom(seed);

  const h = Math.floor(rng() * 360); // Hue: 0-359
  const s = 50 + Math.floor(rng() * 30); // Saturation: 50-79%
  const l = 40 + Math.floor(rng() * 20); // Lightness: 40-59%

  return `hsl(${h}, ${s}%, ${l}%)`;
}

/**
 * Generate deterministic alphanumeric ID.
 *
 * @param seed - Seed string
 * @param length - Length of generated ID (default: 8)
 * @returns Alphanumeric ID string
 *
 * @example
 * ```ts
 * const id = seededId('clip', 8); // e.g., "a3f8b2c1"
 * ```
 */
export function seededId(seed: string, length: number = 8): string {
  const rng = seededRandom(seed);
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';

  for (let i = 0; i < length; i++) {
    const index = Math.floor(rng() * chars.length);
    result += chars[index];
  }

  return result;
}

/**
 * Deterministically choose an item from an array.
 *
 * @param seed - Seed string
 * @param items - Array of items to choose from
 * @returns Selected item
 * @throws Error if array is empty
 *
 * @example
 * ```ts
 * const fonts = ['Arial', 'Helvetica', 'Georgia'];
 * const font = seededChoice('title-font', fonts); // Same choice each time
 * ```
 */
export function seededChoice<T>(seed: string, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error('Cannot choose from empty array');
  }

  const rng = seededRandom(seed);
  const index = Math.floor(rng() * items.length);
  return items[index];
}

/**
 * Deterministically shuffle an array (Fisher-Yates).
 *
 * @param seed - Seed string
 * @param items - Array to shuffle (modified in place)
 * @returns Same array, shuffled
 *
 * @example
 * ```ts
 * const clips = ['clip1', 'clip2', 'clip3'];
 * const shuffled = seededShuffle('random-order', [...clips]);
 * // Same order every time for same seed
 * ```
 */
export function seededShuffle<T>(seed: string, items: T[]): T[] {
  if (items.length <= 1) {
    return items;
  }

  const rng = seededRandom(seed);

  // Fisher-Yates shuffle
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }

  return items;
}

/**
 * Generate deterministic integer in range [min, max] (inclusive).
 *
 * @param seed - Seed string
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 * @returns Integer in range
 *
 * @example
 * ```ts
 * const duration = seededInt('clip-duration', 5, 30); // 5-30 seconds
 * ```
 */
export function seededInt(seed: string, min: number, max: number): number {
  const rng = seededRandom(seed);
  return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Generate deterministic float in range [min, max).
 *
 * @param seed - Seed string
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (exclusive)
 * @returns Float in range
 *
 * @example
 * ```ts
 * const opacity = seededFloat('effect-opacity', 0.5, 1.0);
 * ```
 */
export function seededFloat(seed: string, min: number, max: number): number {
  const rng = seededRandom(seed);
  return rng() * (max - min) + min;
}

/**
 * Generate deterministic boolean with given probability.
 *
 * @param seed - Seed string
 * @param probability - Probability of true (0-1, default: 0.5)
 * @returns Boolean value
 *
 * @example
 * ```ts
 * const hasEffect = seededBoolean('apply-blur', 0.3); // 30% chance true
 * ```
 */
export function seededBoolean(seed: string, probability: number = 0.5): boolean {
  const rng = seededRandom(seed);
  return rng() < probability;
}
