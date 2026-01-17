/**
 * FFmpeg IPC API Wrapper
 *
 * Provides type-safe access to FFmpeg-related Tauri IPC commands.
 */

import { invoke } from '@tauri-apps/api/core';
import type { FFmpegStatus, MediaInfo } from '@/types';

// =============================================================================
// Types
// =============================================================================

export interface ExtractFrameOptions {
  inputPath: string;
  timeSec: number;
  outputPath: string;
}

export interface GenerateThumbnailOptions {
  inputPath: string;
  outputPath: string;
  width?: number;
  height?: number;
}

export interface GenerateWaveformOptions {
  inputPath: string;
  outputPath: string;
  width: number;
  height: number;
}

// =============================================================================
// API Functions
// =============================================================================

/**
 * Check if FFmpeg is available and get its status
 */
export async function checkFFmpeg(): Promise<FFmpegStatus> {
  return invoke<FFmpegStatus>('check_ffmpeg');
}

/**
 * Extract a single frame from a video file
 *
 * @param options.inputPath - Path to the input video file
 * @param options.timeSec - Time in seconds to extract the frame
 * @param options.outputPath - Path to save the extracted frame (PNG/JPEG)
 */
export async function extractFrame(options: ExtractFrameOptions): Promise<void> {
  return invoke<void>('extract_frame', {
    inputPath: options.inputPath,
    timeSec: options.timeSec,
    outputPath: options.outputPath,
  });
}

/**
 * Probe a media file to get its information
 *
 * @param inputPath - Path to the media file
 * @returns Media information including duration, format, streams
 */
export async function probeMedia(inputPath: string): Promise<MediaInfo> {
  return invoke<MediaInfo>('probe_media', { inputPath });
}

/**
 * Generate a thumbnail image from a video file
 *
 * @param options.inputPath - Path to the input video file
 * @param options.outputPath - Path to save the thumbnail
 * @param options.width - Optional thumbnail width
 * @param options.height - Optional thumbnail height
 */
export async function generateThumbnail(options: GenerateThumbnailOptions): Promise<void> {
  return invoke<void>('generate_thumbnail', {
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    width: options.width ?? null,
    height: options.height ?? null,
  });
}

/**
 * Generate an audio waveform image from a media file
 *
 * @param options.inputPath - Path to the input audio/video file
 * @param options.outputPath - Path to save the waveform image
 * @param options.width - Waveform image width in pixels
 * @param options.height - Waveform image height in pixels
 */
export async function generateWaveform(options: GenerateWaveformOptions): Promise<void> {
  return invoke<void>('generate_waveform', {
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    width: options.width,
    height: options.height,
  });
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Generate a temporary file path for frame extraction
 */
export function getTempFramePath(assetId: string, timeSec: number): string {
  const safeTime = Math.floor(timeSec * 1000);
  return `${assetId}_frame_${safeTime}.png`;
}

/**
 * Check if a path is a video file based on extension
 */
export function isVideoFile(path: string): boolean {
  const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv'];
  const ext = path.toLowerCase().substring(path.lastIndexOf('.'));
  return videoExtensions.includes(ext);
}

/**
 * Check if a path is an audio file based on extension
 */
export function isAudioFile(path: string): boolean {
  const audioExtensions = ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.wma'];
  const ext = path.toLowerCase().substring(path.lastIndexOf('.'));
  return audioExtensions.includes(ext);
}

/**
 * Check if a path is an image file based on extension
 */
export function isImageFile(path: string): boolean {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff'];
  const ext = path.toLowerCase().substring(path.lastIndexOf('.'));
  return imageExtensions.includes(ext);
}
