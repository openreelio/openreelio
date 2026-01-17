/**
 * FFmpeg Utilities Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getTempFramePath,
  isVideoFile,
  isAudioFile,
  isImageFile,
} from './ffmpeg';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('FFmpeg Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getTempFramePath', () => {
    it('should generate a unique path for each time', () => {
      const path1 = getTempFramePath('asset1', 1.5);
      const path2 = getTempFramePath('asset1', 2.5);

      expect(path1).not.toBe(path2);
      expect(path1).toContain('asset1');
      expect(path1).toContain('.png');
    });

    it('should handle zero time', () => {
      const path = getTempFramePath('asset1', 0);
      expect(path).toBe('asset1_frame_0.png');
    });

    it('should convert time to milliseconds', () => {
      const path = getTempFramePath('asset1', 1.234);
      expect(path).toBe('asset1_frame_1234.png');
    });
  });

  describe('isVideoFile', () => {
    it('should return true for video extensions', () => {
      expect(isVideoFile('video.mp4')).toBe(true);
      expect(isVideoFile('video.mov')).toBe(true);
      expect(isVideoFile('video.avi')).toBe(true);
      expect(isVideoFile('video.mkv')).toBe(true);
      expect(isVideoFile('video.webm')).toBe(true);
    });

    it('should return false for non-video extensions', () => {
      expect(isVideoFile('audio.mp3')).toBe(false);
      expect(isVideoFile('image.png')).toBe(false);
      expect(isVideoFile('document.pdf')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isVideoFile('VIDEO.MP4')).toBe(true);
      expect(isVideoFile('video.MOV')).toBe(true);
    });
  });

  describe('isAudioFile', () => {
    it('should return true for audio extensions', () => {
      expect(isAudioFile('audio.mp3')).toBe(true);
      expect(isAudioFile('audio.wav')).toBe(true);
      expect(isAudioFile('audio.aac')).toBe(true);
      expect(isAudioFile('audio.flac')).toBe(true);
    });

    it('should return false for non-audio extensions', () => {
      expect(isAudioFile('video.mp4')).toBe(false);
      expect(isAudioFile('image.png')).toBe(false);
      expect(isAudioFile('document.pdf')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isAudioFile('AUDIO.MP3')).toBe(true);
      expect(isAudioFile('audio.WAV')).toBe(true);
    });
  });

  describe('isImageFile', () => {
    it('should return true for image extensions', () => {
      expect(isImageFile('image.png')).toBe(true);
      expect(isImageFile('image.jpg')).toBe(true);
      expect(isImageFile('image.jpeg')).toBe(true);
      expect(isImageFile('image.gif')).toBe(true);
      expect(isImageFile('image.webp')).toBe(true);
    });

    it('should return false for non-image extensions', () => {
      expect(isImageFile('video.mp4')).toBe(false);
      expect(isImageFile('audio.mp3')).toBe(false);
      expect(isImageFile('document.pdf')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isImageFile('IMAGE.PNG')).toBe(true);
      expect(isImageFile('image.JPEG')).toBe(true);
    });
  });
});
