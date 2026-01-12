/**
 * Formatters Utility Tests
 *
 * TDD: Tests for time and number formatting utilities
 */

import { describe, it, expect } from 'vitest';
import {
  formatDuration,
  formatTimecode,
  formatFileSize,
  formatRelativeTime,
  parseTimecode,
} from './formatters';

describe('formatDuration', () => {
  it('formats seconds to MM:SS for values under 1 hour', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(599)).toBe('9:59');
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('formats seconds to HH:MM:SS for values 1 hour or more', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(7325)).toBe('2:02:05');
    expect(formatDuration(36000)).toBe('10:00:00');
  });

  it('handles decimal seconds by truncating', () => {
    expect(formatDuration(65.7)).toBe('1:05');
    expect(formatDuration(3661.999)).toBe('1:01:01');
  });

  it('handles negative values by treating as zero', () => {
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('formatTimecode', () => {
  it('formats seconds to HH:MM:SS:FF timecode at 30fps', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00');
    expect(formatTimecode(1, 30)).toBe('00:00:01:00');
    expect(formatTimecode(1.5, 30)).toBe('00:00:01:15');
    expect(formatTimecode(61.1, 30)).toBe('00:01:01:03');
  });

  it('formats seconds to HH:MM:SS:FF timecode at 24fps', () => {
    expect(formatTimecode(0, 24)).toBe('00:00:00:00');
    expect(formatTimecode(1, 24)).toBe('00:00:01:00');
    expect(formatTimecode(1.5, 24)).toBe('00:00:01:12');
  });

  it('formats seconds to HH:MM:SS:FF timecode at 60fps', () => {
    expect(formatTimecode(1.5, 60)).toBe('00:00:01:30');
  });

  it('handles hours correctly', () => {
    expect(formatTimecode(3661.5, 30)).toBe('01:01:01:15');
  });
});

describe('parseTimecode', () => {
  it('parses HH:MM:SS:FF timecode to seconds at 30fps', () => {
    expect(parseTimecode('00:00:00:00', 30)).toBe(0);
    expect(parseTimecode('00:00:01:00', 30)).toBe(1);
    expect(parseTimecode('00:00:01:15', 30)).toBe(1.5);
    expect(parseTimecode('00:01:01:03', 30)).toBeCloseTo(61.1, 1);
  });

  it('parses HH:MM:SS:FF timecode to seconds at 24fps', () => {
    expect(parseTimecode('00:00:01:12', 24)).toBe(1.5);
  });

  it('returns 0 for invalid timecode', () => {
    expect(parseTimecode('invalid', 30)).toBe(0);
    expect(parseTimecode('', 30)).toBe(0);
    expect(parseTimecode('00:00:00', 30)).toBe(0);
  });
});

describe('formatFileSize', () => {
  it('formats bytes to human readable size', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(500)).toBe('500 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1048576)).toBe('1.0 MB');
    expect(formatFileSize(1073741824)).toBe('1.0 GB');
    expect(formatFileSize(1099511627776)).toBe('1.0 TB');
  });

  it('formats with appropriate decimal places', () => {
    expect(formatFileSize(1500000)).toBe('1.4 MB');
    expect(formatFileSize(2500000000)).toBe('2.3 GB');
  });
});

describe('formatRelativeTime', () => {
  it('formats recent times as "Just now"', () => {
    const now = new Date();
    expect(formatRelativeTime(now.toISOString())).toBe('Just now');
  });

  it('formats times within a minute as "Just now"', () => {
    const thirtySecsAgo = new Date(Date.now() - 30 * 1000);
    expect(formatRelativeTime(thirtySecsAgo.toISOString())).toBe('Just now');
  });

  it('formats times within an hour as minutes ago', () => {
    const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatRelativeTime(fiveMinsAgo.toISOString())).toBe('5 minutes ago');

    const oneMinAgo = new Date(Date.now() - 60 * 1000);
    expect(formatRelativeTime(oneMinAgo.toISOString())).toBe('1 minute ago');
  });

  it('formats times within a day as hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(formatRelativeTime(twoHoursAgo.toISOString())).toBe('2 hours ago');

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    expect(formatRelativeTime(oneHourAgo.toISOString())).toBe('1 hour ago');
  });

  it('formats times within a week as days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(threeDaysAgo.toISOString())).toBe('3 days ago');

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(oneDayAgo.toISOString())).toBe('1 day ago');
  });

  it('formats older times as date string', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const result = formatRelativeTime(twoWeeksAgo.toISOString());
    // Should be a date string, not relative
    expect(result).not.toContain('ago');
  });
});
