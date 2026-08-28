/**
 * FFmpeg IPC API Wrapper
 *
 * Provides type-safe access to FFmpeg-related Tauri IPC commands.
 */

import { invoke } from '@tauri-apps/api/core';
import type { FFmpegStatus, MediaInfo } from '@/types';
import { normalizeFileUriToPath } from '@/utils/uri';

// =============================================================================
// Types
// =============================================================================

export interface ExtractFrameOptions {
  inputPath: string;
  timeSec: number;
  outputPath: string;
}

export interface PreviewFrameOptions {
  /** Path (or file URI) of the media the frame is decoded from. */
  inputPath: string;
  /** Source time of the wanted frame, in seconds. */
  timeSec: number;
  /** Width of the box the frame is fitted inside, in pixels. */
  maxWidth: number;
  /** Height of the box the frame is fitted inside, in pixels. */
  maxHeight: number;
}

export interface PreviewFrameData {
  /** Width of the decoded frame, after aspect-preserving downscale. */
  width: number;
  /** Height of the decoded frame, after aspect-preserving downscale. */
  height: number;
  /**
   * Index of this frame in the source's frame sequence.
   *
   * `null` for a variable-rate source, whose presentation times are not
   * `index / fps`; such a frame can only be addressed by the time it answers
   * for.
   */
  frameIndex: number | null;
  /** The source time this frame answers for, in seconds. */
  sourceTime: number;
  /** `width * height * 4` bytes of straight-alpha RGBA. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
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

function normalizeLocalMediaInputPath(inputPath: string): string {
  return normalizeFileUriToPath(inputPath);
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
    inputPath: normalizeLocalMediaInputPath(options.inputPath),
    timeSec: options.timeSec,
    outputPath: options.outputPath,
  });
}

/** Size of the header the resident preview decoder prepends to its pixels. */
const PREVIEW_FRAME_HEADER_BYTES = 32;

/** Wire version this build knows how to read. */
const PREVIEW_FRAME_WIRE_VERSION = 2;

/** Header flag: the frame index is meaningful for this source. */
const PREVIEW_FRAME_FLAG_INDEXED = 1;

/** Bytes per pixel in the decoder's `rgba` output. */
const PREVIEW_FRAME_BYTES_PER_PIXEL = 4;

/** The IPC reply as bytes, whichever shape the runtime handed back. */
function toFrameBytes(payload: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (Array.isArray(payload)) return Uint8Array.from(payload);
  return new Uint8Array(payload);
}

/**
 * Reads the resident decoder's reply: a 32-byte little-endian header
 * (version, width, height, frame index, source time, flags, reserved) followed
 * by raw RGBA.
 *
 * Exported so the frame path can be tested without a live decoder.
 */
export function decodePreviewFrameReply(
  payload: ArrayBuffer | Uint8Array | number[],
): PreviewFrameData {
  const bytes = toFrameBytes(payload);
  if (bytes.byteLength < PREVIEW_FRAME_HEADER_BYTES) {
    throw new Error('Preview frame reply is shorter than its header');
  }

  const header = new DataView(bytes.buffer, bytes.byteOffset, PREVIEW_FRAME_HEADER_BYTES);
  const version = header.getUint32(0, true);
  if (version !== PREVIEW_FRAME_WIRE_VERSION) {
    throw new Error(`Unsupported preview frame version ${version}`);
  }

  const width = header.getUint32(4, true);
  const height = header.getUint32(8, true);
  const rawFrameIndex = header.getUint32(12, true);
  const sourceTime = header.getFloat64(16, true);
  const flags = header.getUint32(24, true);
  // A variable-rate source ships a zero index with the flag clear; reading that
  // zero as "frame zero" would key every one of its frames to the same picture.
  const frameIndex = (flags & PREVIEW_FRAME_FLAG_INDEXED) !== 0 ? rawFrameIndex : null;

  const pixels = bytes.subarray(PREVIEW_FRAME_HEADER_BYTES);
  const expected = width * height * PREVIEW_FRAME_BYTES_PER_PIXEL;
  if (pixels.byteLength !== expected) {
    throw new Error(
      `Preview frame carries ${pixels.byteLength} bytes but ${width}x${height} needs ${expected}`,
    );
  }

  return {
    width,
    height,
    frameIndex,
    sourceTime,
    // A view rather than a copy: the reply's buffer is ours alone, and a 1080p
    // frame is 8 MB that nobody needs a second time. The cast is safe because
    // the preview path never uses `SharedArrayBuffer` (which would need
    // cross-origin isolation the app does not enable).
    pixels: new Uint8ClampedArray(
      pixels.buffer as ArrayBuffer,
      pixels.byteOffset,
      pixels.byteLength,
    ),
  };
}

/**
 * Decode the frame nearest `timeSec` through the resident preview decoder.
 *
 * The decoder keeps a live FFmpeg per source and streams raw RGBA, so an
 * in-order request costs one pipe read rather than a process spawn. The frame is
 * fitted inside `maxWidth` by `maxHeight` with its aspect ratio intact, because
 * the preview canvas composites with a contain-fit that reads the drawable's own
 * dimensions.
 */
export async function getPreviewFrame(options: PreviewFrameOptions): Promise<PreviewFrameData> {
  const payload = await invoke<ArrayBuffer | Uint8Array | number[]>('get_preview_frame', {
    inputPath: normalizeLocalMediaInputPath(options.inputPath),
    timeSec: options.timeSec,
    maxWidth: Math.max(1, Math.round(options.maxWidth)),
    maxHeight: Math.max(1, Math.round(options.maxHeight)),
  });

  return decodePreviewFrameReply(payload);
}

/**
 * Kill every resident preview decoder.
 *
 * Called when the canvas preview goes away so no FFmpeg outlives the thing that
 * was displaying its frames.
 */
export async function releasePreviewDecoders(): Promise<void> {
  return invoke<void>('release_preview_decoders');
}

/**
 * Probe a media file to get its information
 *
 * @param inputPath - Path to the media file
 * @returns Media information including duration, format, streams
 */
export async function probeMedia(inputPath: string): Promise<MediaInfo> {
  return invoke<MediaInfo>('probe_media', {
    inputPath: normalizeLocalMediaInputPath(inputPath),
  });
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
    inputPath: normalizeLocalMediaInputPath(options.inputPath),
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
    inputPath: normalizeLocalMediaInputPath(options.inputPath),
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
