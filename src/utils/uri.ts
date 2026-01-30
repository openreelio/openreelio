/**
 * URI utilities
 *
 * Frontend code frequently receives local file references as either plain paths
 * or as file URLs (e.g. `file:///C:/path/to/file.mp4`).
 *
 * This module normalizes those inputs into a local path string that can be
 * safely passed to backend commands expecting filesystem paths.
 */

/**
 * Converts a `file://` URL into a local path.
 *
 * - `file:///path/to/file` -> `/path/to/file`
 * - `file:///C:/path/to/file` -> `C:/path/to/file` (Windows)
 * - Percent-encoded segments are decoded.
 *
 * For non-`file://` inputs, returns the original string unchanged.
 */
export function normalizeFileUriToPath(input: string): string {
  if (!input.startsWith('file://')) return input;

  try {
    const url = new URL(input);
    const decodedPathname = decodeURIComponent(url.pathname);

    // Windows file URLs are typically like: file:///C:/path/to/file
    if (
      decodedPathname.length >= 3 &&
      decodedPathname.startsWith('/') &&
      /[A-Za-z]/.test(decodedPathname[1] ?? '') &&
      decodedPathname[2] === ':'
    ) {
      return decodedPathname.slice(1);
    }

    return decodedPathname;
  } catch {
    return input.slice('file://'.length);
  }
}

