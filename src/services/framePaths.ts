/**
 * Frame paths
 *
 * Centralizes where extracted preview frames are written.
 *
 * In production (MSI installed), writing relative paths like `.openreelio/frames`
 * can resolve to a non-writable directory (e.g., Program Files), causing repeated
 * extraction failures and a flood of spawned FFmpeg processes.
 *
 * We instead place frames in the per-user Tauri cache directory.
 */

import { appCacheDir, join } from '@tauri-apps/api/path';
import { createLogger } from '@/services/logger';

const logger = createLogger('FramePaths');

/** Fallback directory for non-Tauri environments */
const FALLBACK_FRAMES_DIR = '.openreelio/frames';

/** Maximum length for sanitized file keys */
const MAX_FILE_KEY_LENGTH = 100;

/** Cached promise for frames directory resolution */
let framesDirPromise: Promise<string> | null = null;

/** Lock to prevent concurrent initialization races */
let framesDirInitLock = false;

/**
 * Check if running in Tauri runtime environment.
 * Extracted for testability and consistent checking.
 */
export function isTauriRuntime(): boolean {
  return (
    typeof (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
  );
}

/**
 * Sanitizes a file key to prevent path traversal attacks and ensure filesystem compatibility.
 *
 * Security: Removes any path separators, parent directory references, and non-alphanumeric
 * characters except dash and underscore. Truncates to MAX_FILE_KEY_LENGTH.
 *
 * @param fileKey - The raw file key to sanitize
 * @returns A sanitized, filesystem-safe key
 */
export function sanitizeFileKey(fileKey: string): string {
  if (!fileKey || typeof fileKey !== 'string') {
    logger.warn('Invalid fileKey provided, using fallback', { fileKey });
    return 'unknown_asset';
  }

  // Remove path traversal attempts and dangerous characters
  const sanitized = fileKey
    // Remove null bytes (potential security issue) - replace with underscore
    .replace(/\0/g, '_')
    // Remove path separators and parent directory references
    .replace(/[/\\]+/g, '_')
    .replace(/\.{2,}/g, '_')
    // Keep only alphanumeric, dash, underscore
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    // Collapse multiple underscores
    .replace(/_+/g, '_')
    // Remove leading/trailing underscores
    .replace(/^_+|_+$/g, '')
    // Truncate to max length
    .substring(0, MAX_FILE_KEY_LENGTH);

  if (sanitized.length === 0) {
    logger.warn('FileKey sanitized to empty string, using fallback', { originalFileKey: fileKey });
    return 'unknown_asset';
  }

  return sanitized;
}

/**
 * Validates timestamp to ensure it's a safe, non-negative integer.
 *
 * @param timeMs - The timestamp in milliseconds
 * @returns A validated, non-negative integer timestamp
 */
export function validateTimestamp(timeMs: number): number {
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    logger.warn('Invalid timestamp provided, using 0', { timeMs });
    return 0;
  }
  // Ensure integer to prevent floating point issues in filenames
  return Math.floor(timeMs);
}

/**
 * Validates file extension to ensure it's safe.
 *
 * @param ext - The file extension (without dot)
 * @returns A validated extension or 'png' as fallback
 */
export function validateExtension(ext: string): string {
  const allowedExtensions = ['png', 'jpg', 'jpeg', 'webp'];
  const normalized = (ext || '').toLowerCase().replace(/[^a-z]/g, '');

  if (!allowedExtensions.includes(normalized)) {
    logger.warn('Invalid extension provided, using png', { ext });
    return 'png';
  }

  return normalized;
}

/**
 * Returns the directory where extracted frames should be stored.
 *
 * - Tauri runtime: `${appCacheDir()}/openreelio/frames`
 * - Web runtime: `.openreelio/frames` (best-effort fallback)
 *
 * Thread-safe: Uses a lock to prevent race conditions during initialization.
 * Error-resilient: Falls back to relative path on Tauri API failure.
 */
export async function getFramesCacheDir(): Promise<string> {
  if (!isTauriRuntime()) {
    return FALLBACK_FRAMES_DIR;
  }

  // Double-checked locking pattern for thread-safe initialization
  if (framesDirPromise) {
    return framesDirPromise;
  }

  // Prevent race condition during initial creation
  if (framesDirInitLock) {
    // Another caller is initializing; wait and retry
    await new Promise((resolve) => setTimeout(resolve, 10));
    return getFramesCacheDir();
  }

  framesDirInitLock = true;

  try {
    framesDirPromise = (async () => {
      try {
        const base = await appCacheDir();
        const framesDir = await join(base, 'openreelio', 'frames');
        logger.debug('Frames cache directory resolved', { framesDir });
        return framesDir;
      } catch (error) {
        logger.error('Failed to resolve Tauri cache directory, using fallback', { error });
        // Return fallback on Tauri API failure (defensive)
        return FALLBACK_FRAMES_DIR;
      }
    })();

    return framesDirPromise;
  } finally {
    framesDirInitLock = false;
  }
}

/**
 * Build an absolute output path for a single extracted frame.
 *
 * Security: All inputs are sanitized to prevent path traversal attacks.
 *
 * @param fileKey - Identifier for the source file (will be sanitized)
 * @param timeMs - Timestamp in milliseconds (will be validated)
 * @param ext - File extension without dot (will be validated)
 * @returns Absolute path for the frame file
 */
export async function buildFrameOutputPath(
  fileKey: string,
  timeMs: number,
  ext: string,
): Promise<string> {
  const sanitizedKey = sanitizeFileKey(fileKey);
  const validatedTime = validateTimestamp(timeMs);
  const validatedExt = validateExtension(ext);

  const filename = `${sanitizedKey}_${validatedTime}.${validatedExt}`;
  const dir = await getFramesCacheDir();

  if (!isTauriRuntime()) {
    return `${dir}/${filename}`;
  }

  try {
    return await join(dir, filename);
  } catch (error) {
    logger.error('Failed to join path in Tauri runtime, using fallback', { error, dir, filename });
    return `${dir}/${filename}`;
  }
}

/**
 * Reset the cached frames directory promise.
 * Primarily for testing purposes.
 */
export function resetFramesDirCache(): void {
  framesDirPromise = null;
  framesDirInitLock = false;
}
