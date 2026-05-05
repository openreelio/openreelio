const ASSET_LOCALHOST_PREFIX = 'http://asset.localhost/';
const ASSET_PROTOCOL_PREFIX = 'asset://localhost/';
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\//;

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
    trimmed.startsWith(ASSET_PROTOCOL_PREFIX) ||
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
  let decodedTrimmed: string;
  try {
    decodedTrimmed = decodeURIComponent(trimmed);
  } catch {
    return null;
  }

  const normalized = trimmed.replace(/\\/g, '/');
  const decodedNormalized = decodedTrimmed.replace(/\\/g, '/');
  const lowerDecoded = decodedTrimmed.toLowerCase();

  if (
    !trimmed ||
    hasControlCharacter(trimmed) ||
    hasControlCharacter(decodedTrimmed) ||
    trimmed.includes('://') ||
    decodedTrimmed.includes('://') ||
    trimmed.startsWith('file:') ||
    lowerDecoded.startsWith('file:') ||
    decodedNormalized.startsWith('/') ||
    WINDOWS_DRIVE_PATH.test(decodedNormalized) ||
    decodedNormalized.split('/').some((segment) => segment === '..')
  ) {
    return null;
  }

  return `${ASSET_PROTOCOL_PREFIX}${normalized}`;
}
