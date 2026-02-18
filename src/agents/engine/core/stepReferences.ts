/**
 * Step Reference Utilities
 *
 * Supports typed references between plan steps so later tool arguments can
 * safely consume outputs from earlier steps.
 */

export interface StepValueReference {
  /** Source step ID that produced the value */
  $fromStep: string;
  /** Dot/bracket path inside the source step ToolExecutionResult */
  $path: string;
  /** Optional fallback value when the path cannot be resolved */
  $default?: unknown;
}

export interface StepReferenceOccurrence {
  /** Location within the args object where this reference was found */
  sourcePath: string;
  /** Reference payload */
  reference: StepValueReference;
}

export interface StepReferenceResolutionError {
  /** Location within the args object where resolution failed */
  sourcePath: string;
  /** Reference payload that failed to resolve */
  reference: StepValueReference;
  /** Human-readable failure reason */
  reason: string;
}

export interface StepReferenceResolutionResult<T> {
  /** Resolved value with references replaced */
  value: T;
  /** All step IDs referenced while resolving */
  referencedStepIds: string[];
  /** Resolution errors, empty when successful */
  errors: StepReferenceResolutionError[];
}

type ResolverResult = { ok: true; value: unknown } | { ok: false; reason: string };

interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
}

export function isStepValueReference(value: unknown): value is StepValueReference {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.$fromStep === 'string' &&
    value.$fromStep.trim().length > 0 &&
    typeof value.$path === 'string' &&
    value.$path.trim().length > 0
  );
}

export function collectStepValueReferences(
  value: unknown,
  sourcePath: string = '$',
): StepReferenceOccurrence[] {
  if (isStepValueReference(value)) {
    return [{ sourcePath, reference: value }];
  }

  if (Array.isArray(value)) {
    const collected: StepReferenceOccurrence[] = [];
    value.forEach((item, index) => {
      collected.push(...collectStepValueReferences(item, `${sourcePath}[${index}]`));
    });
    return collected;
  }

  if (!isRecord(value)) {
    return [];
  }

  const collected: StepReferenceOccurrence[] = [];
  for (const [key, nested] of Object.entries(value)) {
    collected.push(...collectStepValueReferences(nested, `${sourcePath}.${key}`));
  }

  return collected;
}

export function normalizeReferencesForValidation<T>(value: T, schema?: unknown): T {
  return normalizeValue(value, schema as JsonSchemaLike | undefined) as T;
}

export function resolveStepValueReferences<T>(
  value: T,
  resolver: (reference: StepValueReference) => ResolverResult,
  sourcePath: string = '$',
): StepReferenceResolutionResult<T> {
  const referencedStepIds = new Set<string>();
  const errors: StepReferenceResolutionError[] = [];

  const resolveValue = (currentValue: unknown, currentPath: string): unknown => {
    if (isStepValueReference(currentValue)) {
      referencedStepIds.add(currentValue.$fromStep);
      const resolved = resolver(currentValue);

      if (resolved.ok) {
        return resolved.value;
      }

      errors.push({
        sourcePath: currentPath,
        reference: currentValue,
        reason: resolved.reason,
      });

      return undefined;
    }

    if (Array.isArray(currentValue)) {
      return currentValue.map((item, index) => resolveValue(item, `${currentPath}[${index}]`));
    }

    if (!isRecord(currentValue)) {
      return currentValue;
    }

    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(currentValue)) {
      next[key] = resolveValue(nested, `${currentPath}.${key}`);
    }

    return next;
  };

  const resolvedValue = resolveValue(value, sourcePath) as T;
  return {
    value: resolvedValue,
    referencedStepIds: Array.from(referencedStepIds),
    errors,
  };
}

export function getValueAtReferencePath(
  source: unknown,
  rawPath: string,
): { found: true; value: unknown } | { found: false } {
  const path = rawPath.trim().replace(/^\$\.?/, '');
  if (!path) {
    return { found: true, value: source };
  }

  const tokens = tokenizePath(path);
  let current: unknown = source;

  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false };
      }
      current = current[index];
      continue;
    }

    if (!isRecord(current)) {
      return { found: false };
    }

    if (!Object.prototype.hasOwnProperty.call(current, token)) {
      return { found: false };
    }

    current = current[token];
  }

  return { found: true, value: current };
}

function normalizeValue(value: unknown, schema?: JsonSchemaLike): unknown {
  if (isStepValueReference(value)) {
    return createValidationPlaceholder(schema, value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, schema?.items));
  }

  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    normalized[key] = normalizeValue(nested, schema?.properties?.[key]);
  }

  return normalized;
}

function createValidationPlaceholder(
  schema: JsonSchemaLike | undefined,
  reference: StepValueReference,
): unknown {
  switch (schema?.type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    case 'string':
    default:
      return `ref:${reference.$fromStep}.${reference.$path}`;
  }
}

function tokenizePath(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((token) => token.trim())
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
