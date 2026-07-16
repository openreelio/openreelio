/**
 * Shared structural-narrowing primitives for external-agent notification
 * mappers. Both the Codex and Claude mappers translate arbitrary JSON coming
 * off a CLI stream, so every field access goes through these type guards rather
 * than trusting the payload shape.
 */

/** JSON object alias used when narrowing arbitrary stream payloads. */
export type JsonObject = Record<string, unknown>;

/** Returns the value as a plain JSON object, or null when it is not one. */
export function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

/** Returns the value as an array, or an empty array when it is not one. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Reads a string field from a JSON object, or null when absent/non-string. */
export function getString(input: JsonObject | null | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' ? value : null;
}

/** Reads a boolean field from a JSON object, or null when absent/non-boolean. */
export function getBoolean(input: JsonObject | null | undefined, key: string): boolean | null {
  const value = input?.[key];
  return typeof value === 'boolean' ? value : null;
}

/** Reads a number field from a JSON object, or null when absent/non-number. */
export function getNumber(input: JsonObject | null | undefined, key: string): number | null {
  const value = input?.[key];
  return typeof value === 'number' ? value : null;
}
