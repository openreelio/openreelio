const ASSET_LOCALHOST_PREFIX = 'http://asset.localhost/';

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function sanitizeRendererImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || hasControlCharacter(trimmed)) {
    return null;
  }

  if (
    trimmed.startsWith('asset://') ||
    trimmed.startsWith(ASSET_LOCALHOST_PREFIX) ||
    trimmed.startsWith('blob:')
  ) {
    return trimmed;
  }

  return null;
}

export function buildSafeAssetImageUrl(path: unknown): string | null {
  if (typeof path !== 'string') {
    return null;
  }

  const trimmed = path.trim();
  if (
    !trimmed ||
    hasControlCharacter(trimmed) ||
    trimmed.includes('://') ||
    trimmed.startsWith('file:') ||
    trimmed
      .replace(/\\/g, '/')
      .split('/')
      .some((segment) => segment === '..')
  ) {
    return null;
  }

  return `asset://localhost/${trimmed}`;
}
