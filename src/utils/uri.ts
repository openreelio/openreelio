/**
 * URI utilities
 *
 * Frontend code frequently receives local file references as either plain paths,
 * `file://` URLs, or Tauri asset protocol URLs.
 *
 * This module normalizes those inputs into a local path string that can be
 * safely passed to backend commands expecting filesystem paths.
 */

function normalizeWindowsDrivePath(pathname: string): string {
  if (
    pathname.length >= 3 &&
    pathname.startsWith('/') &&
    /[A-Za-z]/.test(pathname[1] ?? '') &&
    pathname[2] === ':'
  ) {
    return pathname.slice(1);
  }

  return pathname;
}

function decodePathname(url: URL): string {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

/**
 * Converts local media URL forms into a local filesystem path.
 *
 * - `file:///path/to/file` -> `/path/to/file`
 * - `file:///C:/path/to/file` -> `C:/path/to/file` (Windows)
 * - `asset://localhost/path/to/file` -> `/path/to/file`
 * - `asset://localhost/C:/path/to/file` -> `C:/path/to/file` (Windows)
 * - Percent-encoded segments are decoded.
 *
 * For unsupported/non-local URI schemes, returns the original string unchanged.
 */
export function normalizeFileUriToPath(input: string): string {
  const trimmed = input.trim();

  if (trimmed.startsWith('file://')) {
    try {
      const url = new URL(trimmed);
      const decodedPathname = decodePathname(url);
      return normalizeWindowsDrivePath(decodedPathname);
    } catch {
      return trimmed.slice('file://'.length);
    }
  }

  if (trimmed.startsWith('asset://')) {
    try {
      const url = new URL(trimmed);
      if (url.hostname !== 'localhost') {
        return trimmed;
      }

      const decodedPathname = decodePathname(url);
      return normalizeWindowsDrivePath(decodedPathname);
    } catch {
      const localhostPrefix = 'asset://localhost/';
      if (!trimmed.startsWith(localhostPrefix)) {
        return trimmed;
      }

      try {
        const decoded = decodeURIComponent(trimmed.slice(localhostPrefix.length));
        return normalizeWindowsDrivePath(decoded.startsWith('/') ? decoded : `/${decoded}`);
      } catch {
        const raw = trimmed.slice(localhostPrefix.length);
        return normalizeWindowsDrivePath(raw.startsWith('/') ? raw : `/${raw}`);
      }
    }
  }

  return trimmed;
}
