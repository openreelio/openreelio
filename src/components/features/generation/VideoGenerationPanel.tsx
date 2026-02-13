/**
 * VideoGenerationPanel Component
 *
 * Main panel for AI video generation. Provides a prompt input,
 * generation options (mode, quality, duration, aspect ratio),
 * cost estimation, and a list of active/recent generation jobs.
 *
 * Gated behind the USE_VIDEO_GENERATION feature flag.
 */

import { useState, useCallback, useMemo, memo } from 'react';
import { Sparkles } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useVideoGenStore } from '@/stores/videoGenStore';
import { CostEstimateDisplay } from './CostEstimateDisplay';
import { GenerationHistory } from './GenerationHistory';
import { createLogger } from '@/services/logger';

const logger = createLogger('VideoGenerationPanel');

// =============================================================================
// Types
// =============================================================================

export interface VideoGenerationPanelProps {
  /** Whether the panel is disabled */
  disabled?: boolean;
  /** Whether to use compact mode (bottom panel) */
  compact?: boolean;
  /** Optional class name */
  className?: string;
}

// =============================================================================
// Constants
// =============================================================================

const QUALITY_OPTIONS = [
  { value: 'basic', label: 'Basic', price: '~$0.10/min' },
  { value: 'pro', label: 'Pro', price: '~$0.30/min' },
  { value: 'cinema', label: 'Cinema', price: '~$0.80/min' },
] as const;

const ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const;

// =============================================================================
// Component
// =============================================================================

export const VideoGenerationPanel = memo(function VideoGenerationPanel({
  disabled = false,
  compact = false,
  className = '',
}: VideoGenerationPanelProps) {
  // Form state
  const [prompt, setPrompt] = useState('');
  const [quality, setQuality] = useState<string>('pro');
  const [durationSec, setDurationSec] = useState(10);
  const [aspectRatio, setAspectRatio] = useState('16:9');

  // Cost estimate state
  const [estimate, setEstimate] = useState<{
    estimatedCents: number;
    quality: string;
    durationSec: number;
  } | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Store
  const jobs = useVideoGenStore((s) => Array.from(s.jobs.values()));
  const submitGeneration = useVideoGenStore((s) => s.submitGeneration);
  const cancelJob = useVideoGenStore((s) => s.cancelJob);
  const clearCompletedJobs = useVideoGenStore((s) => s.clearCompletedJobs);

  // Sort jobs: active first, then by creation date descending
  const sortedJobs = useMemo(
    () =>
      [...jobs].sort((a, b) => {
        const aActive = !['completed', 'failed', 'cancelled'].includes(a.status);
        const bActive = !['completed', 'failed', 'cancelled'].includes(b.status);
        if (aActive !== bActive) return aActive ? -1 : 1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }),
    [jobs],
  );

  // Clear stale estimate when generation params change
  const handleQualityChange = useCallback((value: string) => {
    setQuality(value);
    setEstimate(null);
  }, []);

  const handleDurationChange = useCallback((value: number) => {
    setDurationSec(value);
    setEstimate(null);
  }, []);

  // Handlers
  const handleEstimate = useCallback(async () => {
    try {
      setIsEstimating(true);
      setError(null);
      const result = await invoke<{
        estimatedCents: number;
        quality: string;
        durationSec: number;
      }>('estimate_generation_cost', { quality, durationSec });
      setEstimate(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setEstimate(null);
      logger.error('Cost estimation failed', { error: message });
    } finally {
      setIsEstimating(false);
    }
  }, [quality, durationSec]);

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) return;

    try {
      setIsSubmitting(true);
      setError(null);
      await submitGeneration({
        prompt: prompt.trim(),
        quality: quality as 'basic' | 'pro' | 'cinema',
        durationSec,
        aspectRatio,
      });
      setPrompt('');
      setEstimate(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      logger.error('Video generation submission failed', { error: message });
    } finally {
      setIsSubmitting(false);
    }
  }, [prompt, quality, durationSec, aspectRatio, submitGeneration]);

  const handleCancel = useCallback(
    async (jobId: string) => {
      try {
        await cancelJob(jobId);
      } catch (err) {
        logger.error('Cancel failed', { error: String(err) });
      }
    },
    [cancelJob],
  );

  const isFormValid = prompt.trim().length > 0 && !isSubmitting;

  // Compact layout for bottom panel
  if (compact) {
    return (
      <div className={`flex h-full gap-3 p-2 ${className}`}>
        {/* Left: prompt + controls */}
        <div className="flex-1 flex flex-col gap-2 min-w-0">
          <div className="flex gap-2">
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isFormValid) handleGenerate();
              }}
              placeholder="Describe the video to generate..."
              disabled={disabled || isSubmitting}
              className="flex-1 px-3 py-1.5 rounded bg-editor-bg border border-editor-border text-sm text-editor-text placeholder-editor-text-muted focus:outline-none focus:border-primary-500 disabled:opacity-50"
            />
            <select
              value={quality}
              onChange={(e) => handleQualityChange(e.target.value)}
              disabled={disabled || isSubmitting}
              className="px-2 py-1.5 rounded bg-editor-bg border border-editor-border text-xs text-editor-text disabled:opacity-50"
            >
              {QUALITY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={!isFormValid || disabled}
              className="flex items-center gap-1 px-3 py-1.5 rounded bg-primary-600 text-white text-xs hover:bg-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Sparkles className="w-3 h-3" />
              {isSubmitting ? 'Submitting...' : 'Generate'}
            </button>
          </div>
          {error && (
            <p className="text-xs text-red-400 truncate">{error}</p>
          )}
        </div>

        {/* Right: job list */}
        <div className="w-72 shrink-0 overflow-y-auto border-l border-editor-border pl-3">
          <GenerationHistory
            jobs={sortedJobs}
            onCancelJob={handleCancel}
            onClearCompleted={clearCompletedJobs}
          />
        </div>
      </div>
    );
  }

  // Full layout for standalone panel
  return (
    <div className={`flex flex-col h-full overflow-hidden ${className}`}>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Prompt */}
        <div>
          <label
            htmlFor="gen-prompt"
            className="block text-sm font-medium text-editor-text-muted mb-1"
          >
            Prompt
          </label>
          <textarea
            id="gen-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the video you want to generate..."
            rows={3}
            disabled={disabled || isSubmitting}
            className="w-full px-3 py-2 rounded bg-editor-bg border border-editor-border text-sm text-editor-text placeholder-editor-text-muted focus:outline-none focus:border-primary-500 disabled:opacity-50 resize-none"
          />
        </div>

        {/* Options row */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label htmlFor="gen-quality" className="block text-xs text-editor-text-muted mb-1">
              Quality
            </label>
            <select
              id="gen-quality"
              value={quality}
              onChange={(e) => handleQualityChange(e.target.value)}
              disabled={disabled || isSubmitting}
              className="w-full px-2 py-1.5 rounded bg-editor-bg border border-editor-border text-sm text-editor-text disabled:opacity-50"
            >
              {QUALITY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} ({opt.price})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="gen-duration" className="block text-xs text-editor-text-muted mb-1">
              Duration ({durationSec}s)
            </label>
            <input
              id="gen-duration"
              type="range"
              min={5}
              max={120}
              step={5}
              value={durationSec}
              onChange={(e) => handleDurationChange(Number(e.target.value))}
              disabled={disabled || isSubmitting}
              className="w-full h-2 bg-editor-border rounded-lg appearance-none cursor-pointer disabled:opacity-50"
            />
          </div>

          <div>
            <label htmlFor="gen-aspect" className="block text-xs text-editor-text-muted mb-1">
              Aspect Ratio
            </label>
            <select
              id="gen-aspect"
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value)}
              disabled={disabled || isSubmitting}
              className="w-full px-2 py-1.5 rounded bg-editor-bg border border-editor-border text-sm text-editor-text disabled:opacity-50"
            >
              {ASPECT_RATIOS.map((ar) => (
                <option key={ar} value={ar}>
                  {ar}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Cost estimate */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleEstimate}
            disabled={isEstimating || disabled}
            className="px-3 py-1.5 rounded border border-editor-border text-xs text-editor-text-muted hover:bg-editor-bg hover:text-editor-text disabled:opacity-50 transition-colors"
          >
            {isEstimating ? 'Estimating...' : 'Estimate Cost'}
          </button>
          {estimate && (
            <CostEstimateDisplay
              estimatedCents={estimate.estimatedCents}
              quality={estimate.quality}
              durationSec={estimate.durationSec}
              className="flex-1"
            />
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="p-2 rounded bg-red-500/10 border border-red-500/20">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        {/* Generate button */}
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!isFormValid || disabled}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Sparkles className="w-4 h-4" />
          {isSubmitting ? 'Submitting...' : 'Generate Video'}
        </button>

        {/* Job history */}
        <GenerationHistory
          jobs={sortedJobs}
          onCancelJob={handleCancel}
          onClearCompleted={clearCompletedJobs}
        />
      </div>
    </div>
  );
});
