/**
 * Formatting Utilities
 *
 * Shared formatting functions for time, file sizes, and other values.
 */

// =============================================================================
// Time Formatting
// =============================================================================

/**
 * Format seconds to human-readable duration (MM:SS or HH:MM:SS)
 *
 * @param seconds - Duration in seconds
 * @returns Formatted duration string
 *
 * @example
 * formatDuration(65) // "1:05"
 * formatDuration(3661) // "1:01:01"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) seconds = 0;

  const totalSeconds = Math.floor(seconds);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format seconds to SMPTE timecode (HH:MM:SS:FF)
 *
 * @param seconds - Time in seconds
 * @param fps - Frames per second
 * @returns Formatted timecode string
 *
 * @example
 * formatTimecode(61.5, 30) // "00:01:01:15"
 */
export function formatTimecode(seconds: number, fps: number): string {
  const totalFrames = Math.floor(seconds * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const secs = totalSeconds % 60;
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const hrs = Math.floor(totalSeconds / 3600);

  return [
    hrs.toString().padStart(2, '0'),
    mins.toString().padStart(2, '0'),
    secs.toString().padStart(2, '0'),
    frames.toString().padStart(2, '0'),
  ].join(':');
}

/**
 * Parse SMPTE timecode (HH:MM:SS:FF) to seconds
 *
 * @param timecode - Timecode string
 * @param fps - Frames per second
 * @returns Time in seconds
 *
 * @example
 * parseTimecode("00:01:01:15", 30) // 61.5
 */
export function parseTimecode(timecode: string, fps: number): number {
  const parts = timecode.split(':');
  if (parts.length !== 4) return 0;

  const [hrs, mins, secs, frames] = parts.map(Number);
  if ([hrs, mins, secs, frames].some(isNaN)) return 0;

  return hrs * 3600 + mins * 60 + secs + frames / fps;
}

// =============================================================================
// File Size Formatting
// =============================================================================

const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * Format bytes to human-readable file size
 *
 * @param bytes - File size in bytes
 * @returns Formatted file size string
 *
 * @example
 * formatFileSize(1536) // "1.5 KB"
 * formatFileSize(1048576) // "1.0 MB"
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const unitIndex = Math.floor(Math.log(bytes) / Math.log(1024));
  const clampedIndex = Math.min(unitIndex, FILE_SIZE_UNITS.length - 1);
  const value = bytes / Math.pow(1024, clampedIndex);

  if (clampedIndex === 0) {
    return `${Math.round(value)} ${FILE_SIZE_UNITS[clampedIndex]}`;
  }

  return `${value.toFixed(1)} ${FILE_SIZE_UNITS[clampedIndex]}`;
}

// =============================================================================
// Relative Time Formatting
// =============================================================================

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Format ISO date string to relative time (e.g., "5 minutes ago")
 *
 * @param isoDate - ISO date string
 * @returns Relative time string
 *
 * @example
 * formatRelativeTime(new Date(Date.now() - 5 * 60 * 1000).toISOString())
 * // "5 minutes ago"
 */
export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  if (diffMs < MINUTE) {
    return 'Just now';
  }

  if (diffMs < HOUR) {
    const mins = Math.floor(diffMs / MINUTE);
    return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  }

  if (diffMs < DAY) {
    const hrs = Math.floor(diffMs / HOUR);
    return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  }

  if (diffMs < WEEK) {
    const days = Math.floor(diffMs / DAY);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  // Format as date for older times
  return date.toLocaleDateString();
}
