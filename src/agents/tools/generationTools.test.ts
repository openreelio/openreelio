/**
 * Generation Tools Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { globalToolRegistry } from '../ToolRegistry';
import {
  registerGenerationTools,
  unregisterGenerationTools,
  getGenerationToolNames,
} from './generationTools';

const mockSubmitGeneration = vi.fn();
const mockGetJob = vi.fn();
const mockCancelJob = vi.fn();
const mockAssets = new Map<string, { id: string; kind: string; uri: string }>();

// Mock @tauri-apps/api/core
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Mock videoGenStore
vi.mock('@/stores/videoGenStore', () => ({
  useVideoGenStore: {
    getState: vi.fn(() => ({
      submitGeneration: mockSubmitGeneration,
      getJob: mockGetJob,
      cancelJob: mockCancelJob,
    })),
  },
}));

// Mock projectStore
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({
      assets: mockAssets,
    })),
  },
}));

// Mock logger
vi.mock('@/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('generationTools', () => {
  beforeEach(() => {
    globalToolRegistry.clear();
    vi.clearAllMocks();
    mockAssets.clear();
    mockSubmitGeneration.mockResolvedValue('job-123');
    mockGetJob.mockReturnValue({
      id: 'job-123',
      status: 'processing',
      progress: 50,
      assetId: null,
      error: null,
      estimatedCostCents: 15,
    });
    mockCancelJob.mockResolvedValue(undefined);
  });

  describe('registration', () => {
    it('should register all generation tools', () => {
      registerGenerationTools();

      const names = getGenerationToolNames();
      expect(names).toContain('generate_video');
      expect(names).toContain('check_generation_status');
      expect(names).toContain('estimate_generation_cost');
      expect(names).toContain('cancel_generation');
      expect(names).toHaveLength(4);

      for (const name of names) {
        expect(globalToolRegistry.has(name)).toBe(true);
      }
    });

    it('should unregister all generation tools', () => {
      registerGenerationTools();
      unregisterGenerationTools();

      for (const name of getGenerationToolNames()) {
        expect(globalToolRegistry.has(name)).toBe(false);
      }
    });
  });

  describe('tool categories', () => {
    it('all generation tools should have category "generation"', () => {
      registerGenerationTools();

      for (const name of getGenerationToolNames()) {
        const tool = globalToolRegistry.get(name);
        expect(tool?.category).toBe('generation');
      }
    });
  });

  describe('generate_video', () => {
    it('should require prompt parameter', () => {
      registerGenerationTools();

      const tool = globalToolRegistry.get('generate_video');
      expect(tool?.parameters.required).toContain('prompt');
    });

    it('should execute successfully with valid params', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      vi.mocked(invoke).mockResolvedValueOnce({
        estimatedCents: 15,
        quality: 'pro',
        durationSec: 10,
      });

      registerGenerationTools();

      const result = await globalToolRegistry.execute(
        'generate_video',
        { prompt: 'A sunset timelapse' },
      );

      expect(result.success).toBe(true);
      expect(result.result).toHaveProperty('jobId');
      expect(result.result).toHaveProperty('estimatedCostCents');
    });

    it('should resolve reference assets and pass URIs to submitGeneration', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      vi.mocked(invoke).mockResolvedValueOnce({
        estimatedCents: 20,
        quality: 'pro',
        durationSec: 20,
      });

      mockAssets.set('img-1', { id: 'img-1', kind: 'image', uri: '/tmp/ref.png' });
      mockAssets.set('vid-1', { id: 'vid-1', kind: 'video', uri: '/tmp/ref.mp4' });

      registerGenerationTools();

      const result = await globalToolRegistry.execute(
        'generate_video',
        { prompt: 'Use references', referenceAssetIds: ['img-1', 'vid-1'] },
      );

      expect(result.success).toBe(true);
      expect(mockSubmitGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          referenceImages: ['/tmp/ref.png'],
          referenceVideos: ['/tmp/ref.mp4'],
        }),
      );
    });

    it('should fail when referenced assets are missing', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      vi.mocked(invoke).mockResolvedValueOnce({
        estimatedCents: 10,
        quality: 'pro',
        durationSec: 10,
      });

      registerGenerationTools();

      const result = await globalToolRegistry.execute(
        'generate_video',
        { prompt: 'Missing ref', referenceAssetIds: ['missing-1'] },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Reference asset(s) not found');
      expect(mockSubmitGeneration).not.toHaveBeenCalled();
    });
  });

  describe('check_generation_status', () => {
    it('should require jobId parameter', () => {
      registerGenerationTools();

      const tool = globalToolRegistry.get('check_generation_status');
      expect(tool?.parameters.required).toContain('jobId');
    });

    it('should return job status', async () => {
      registerGenerationTools();

      const result = await globalToolRegistry.execute(
        'check_generation_status',
        { jobId: 'job-123' },
      );

      expect(result.success).toBe(true);
      expect(result.result).toHaveProperty('status', 'processing');
      expect(result.result).toHaveProperty('progress', 50);
    });
  });

  describe('estimate_generation_cost', () => {
    it('should return cost estimate', async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      vi.mocked(invoke).mockResolvedValueOnce({
        estimatedCents: 30,
        quality: 'pro',
        durationSec: 60,
      });

      registerGenerationTools();

      const result = await globalToolRegistry.execute(
        'estimate_generation_cost',
        { quality: 'pro', durationSec: 60 },
      );

      expect(result.success).toBe(true);
      expect(result.result).toHaveProperty('estimatedCents', 30);
      expect(result.result).toHaveProperty('formattedCost', '$0.30');
    });
  });

  describe('cancel_generation', () => {
    it('should require jobId parameter', () => {
      registerGenerationTools();

      const tool = globalToolRegistry.get('cancel_generation');
      expect(tool?.parameters.required).toContain('jobId');
    });

    it('should cancel and return success', async () => {
      registerGenerationTools();

      const result = await globalToolRegistry.execute(
        'cancel_generation',
        { jobId: 'job-123' },
      );

      expect(result.success).toBe(true);
      expect(result.result).toHaveProperty('cancelled', true);
    });

    it('should return failure when cancel throws', async () => {
      mockCancelJob.mockRejectedValueOnce(new Error('cancel failed'));
      registerGenerationTools();

      const result = await globalToolRegistry.execute(
        'cancel_generation',
        { jobId: 'job-123' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('cancel failed');
    });
  });
});
