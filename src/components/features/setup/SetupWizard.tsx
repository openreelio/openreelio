/**
 * SetupWizard Component
 *
 * First-run setup wizard that guides users through initial configuration:
 * - Step 1: Welcome and introduction
 * - Step 2: FFmpeg availability check
 * - Step 3: Basic settings (theme, default project location)
 * - Step 4: Completion
 */

import { useState, useCallback, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Sparkles, CheckCircle, AlertTriangle, FolderOpen, Palette, ArrowRight, ArrowLeft } from 'lucide-react';
import { useFFmpegStatus } from '@/hooks/useFFmpegStatus';
import { useSettings } from '@/hooks/useSettings';
import { createLogger } from '@/services/logger';

const logger = createLogger('SetupWizard');

// =============================================================================
// Types
// =============================================================================

export interface SetupWizardProps {
  /** Callback when setup is completed */
  onComplete: () => void;
  /** Callback when user skips setup */
  onSkip?: () => void;
  /** App version to display */
  version?: string;
}

type WizardStep = 'welcome' | 'ffmpeg' | 'settings' | 'complete';

// =============================================================================
// Step Components
// =============================================================================

interface StepProps {
  onNext: () => void;
  onBack?: () => void;
  onSkip?: () => void;
}

/** Welcome step - Introduction to OpenReelio */
function WelcomeStep({ onNext, onSkip }: StepProps & { version?: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center text-center p-8">
      <div className="w-20 h-20 rounded-full bg-primary-500/20 flex items-center justify-center mb-6">
        <Sparkles className="w-10 h-10 text-primary-400" />
      </div>

      <h1 className="text-3xl font-bold text-editor-text mb-4">
        Welcome to OpenReelio
      </h1>

      <p className="text-editor-text-muted mb-8 max-w-md">
        AI-powered video editing made simple. Let&apos;s set up a few things
        to get you started with the best experience.
      </p>

      <div className="space-y-3 text-left w-full max-w-sm mb-8">
        <FeatureItem
          icon={<CheckCircle className="w-5 h-5 text-green-400" />}
          text="Prompt-first editing with natural language"
        />
        <FeatureItem
          icon={<CheckCircle className="w-5 h-5 text-green-400" />}
          text="Non-linear timeline with multi-track support"
        />
        <FeatureItem
          icon={<CheckCircle className="w-5 h-5 text-green-400" />}
          text="AI-powered transcription and search"
        />
      </div>

      <div className="flex gap-4">
        <button
          onClick={onSkip}
          className="px-6 py-2 text-sm text-editor-text-muted hover:text-editor-text transition-colors"
        >
          Skip Setup
        </button>
        <button
          onClick={onNext}
          className="flex items-center gap-2 px-6 py-3 bg-primary-600 hover:bg-primary-500 text-white rounded-lg font-medium transition-colors"
        >
          Get Started
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/** FFmpeg check step */
function FFmpegStep({ onNext, onBack }: StepProps): JSX.Element {
  const { isAvailable, isLoading, error, recheck } = useFFmpegStatus();

  return (
    <div className="flex flex-col items-center text-center p-8">
      <h2 className="text-2xl font-bold text-editor-text mb-4">
        FFmpeg Setup
      </h2>

      <p className="text-editor-text-muted mb-8 max-w-md">
        OpenReelio uses FFmpeg for video processing. Let&apos;s check if it&apos;s installed.
      </p>

      <div className="w-full max-w-md p-6 bg-editor-surface rounded-lg mb-8">
        {isLoading ? (
          <div className="flex items-center justify-center gap-3">
            <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-editor-text-muted">Checking FFmpeg...</span>
          </div>
        ) : isAvailable ? (
          <div className="flex items-center gap-3 text-green-400">
            <CheckCircle className="w-8 h-8" />
            <div className="text-left">
              <p className="font-medium">FFmpeg Found</p>
              <p className="text-sm text-editor-text-muted">
                Video processing is ready to use.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-yellow-400">
              <AlertTriangle className="w-8 h-8" />
              <div className="text-left">
                <p className="font-medium">FFmpeg Not Found</p>
                <p className="text-sm text-editor-text-muted">
                  {error || 'FFmpeg is required for video processing.'}
                </p>
              </div>
            </div>

            <div className="text-left text-sm text-editor-text-muted space-y-2 p-4 bg-editor-bg rounded">
              <p className="font-medium text-editor-text">Installation Options:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <strong>Windows:</strong> Download from{' '}
                  <a
                    href="https://ffmpeg.org/download.html"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-400 hover:underline"
                  >
                    ffmpeg.org
                  </a>
                </li>
                <li>
                  <strong>macOS:</strong> Run <code className="bg-black/30 px-1 rounded">brew install ffmpeg</code>
                </li>
                <li>
                  <strong>Linux:</strong> Run <code className="bg-black/30 px-1 rounded">sudo apt install ffmpeg</code>
                </li>
              </ul>
            </div>

            <button
              onClick={() => void recheck()}
              className="w-full py-2 text-sm text-primary-400 hover:text-primary-300 transition-colors"
            >
              Check Again
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-6 py-2 text-editor-text-muted hover:text-editor-text transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <button
          onClick={onNext}
          className="flex items-center gap-2 px-6 py-3 bg-primary-600 hover:bg-primary-500 text-white rounded-lg font-medium transition-colors"
        >
          {isAvailable ? 'Continue' : 'Continue Anyway'}
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/** Settings step - Theme and default location */
function SettingsStep({ onNext, onBack }: StepProps): JSX.Element {
  const { appearance, general, updateAppearance, updateGeneral } = useSettings();
  const [projectLocation, setProjectLocation] = useState(general.defaultProjectLocation || '');

  const handleSelectFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Default Project Location',
      });

      if (selected && typeof selected === 'string') {
        setProjectLocation(selected);
        await updateGeneral({ defaultProjectLocation: selected });
      }
    } catch (error) {
      logger.error('Failed to select folder', { error });
    }
  }, [updateGeneral]);

  const handleThemeChange = useCallback(
    (theme: 'light' | 'dark' | 'system') => {
      void updateAppearance({ theme });
    },
    [updateAppearance]
  );

  return (
    <div className="flex flex-col items-center text-center p-8">
      <h2 className="text-2xl font-bold text-editor-text mb-4">
        Preferences
      </h2>

      <p className="text-editor-text-muted mb-8 max-w-md">
        Customize your editing environment. You can change these later in Settings.
      </p>

      <div className="w-full max-w-md space-y-6 mb-8">
        {/* Theme Selection */}
        <div className="text-left">
          <label className="flex items-center gap-2 text-sm font-medium text-editor-text mb-3">
            <Palette className="w-4 h-4" />
            Theme
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(['dark', 'light', 'system'] as const).map((theme) => (
              <button
                key={theme}
                onClick={() => handleThemeChange(theme)}
                className={`py-3 px-4 rounded-lg border-2 transition-colors capitalize ${
                  appearance.theme === theme
                    ? 'border-primary-500 bg-primary-500/10 text-primary-400'
                    : 'border-editor-border bg-editor-surface text-editor-text-muted hover:border-editor-text-muted'
                }`}
              >
                {theme}
              </button>
            ))}
          </div>
        </div>

        {/* Default Project Location */}
        <div className="text-left">
          <label className="flex items-center gap-2 text-sm font-medium text-editor-text mb-3">
            <FolderOpen className="w-4 h-4" />
            Default Project Location
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={projectLocation}
              readOnly
              placeholder="Not set (will ask each time)"
              className="flex-1 px-3 py-2 bg-editor-surface border border-editor-border rounded-lg text-editor-text text-sm placeholder-editor-text-muted"
            />
            <button
              onClick={() => void handleSelectFolder()}
              className="px-4 py-2 bg-editor-surface border border-editor-border rounded-lg text-editor-text hover:bg-editor-hover transition-colors"
            >
              Browse
            </button>
          </div>
        </div>
      </div>

      <div className="flex gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-6 py-2 text-editor-text-muted hover:text-editor-text transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <button
          onClick={onNext}
          className="flex items-center gap-2 px-6 py-3 bg-primary-600 hover:bg-primary-500 text-white rounded-lg font-medium transition-colors"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/** Complete step */
function CompleteStep({ onComplete }: { onComplete: () => void }): JSX.Element {
  return (
    <div className="flex flex-col items-center text-center p-8">
      <div className="w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center mb-6">
        <CheckCircle className="w-10 h-10 text-green-400" />
      </div>

      <h2 className="text-2xl font-bold text-editor-text mb-4">
        You&apos;re All Set!
      </h2>

      <p className="text-editor-text-muted mb-8 max-w-md">
        OpenReelio is ready to use. Create a new project or open an existing one to get started.
      </p>

      <div className="space-y-3 text-left w-full max-w-sm mb-8 p-4 bg-editor-surface rounded-lg">
        <p className="text-sm font-medium text-editor-text mb-2">Quick Tips:</p>
        <ul className="text-sm text-editor-text-muted space-y-2">
          <li>• Press <kbd className="px-1.5 py-0.5 bg-editor-bg rounded text-xs">Space</kbd> to play/pause</li>
          <li>• Press <kbd className="px-1.5 py-0.5 bg-editor-bg rounded text-xs">S</kbd> to split clip at playhead</li>
          <li>• Drag media files directly onto the timeline</li>
          <li>• Use <kbd className="px-1.5 py-0.5 bg-editor-bg rounded text-xs">Ctrl+Z</kbd> to undo any action</li>
        </ul>
      </div>

      <button
        onClick={onComplete}
        className="flex items-center gap-2 px-8 py-3 bg-primary-600 hover:bg-primary-500 text-white rounded-lg font-medium transition-colors"
      >
        Start Editing
        <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}

/** Feature item for welcome step */
function FeatureItem({ icon, text }: { icon: React.ReactNode; text: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      {icon}
      <span className="text-editor-text-muted">{text}</span>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

const STEPS: WizardStep[] = ['welcome', 'ffmpeg', 'settings', 'complete'];

export function SetupWizard({ onComplete, onSkip, version }: SetupWizardProps): JSX.Element {
  const [currentStep, setCurrentStep] = useState<WizardStep>('welcome');
  const { updateGeneral } = useSettings();

  const currentIndex = STEPS.indexOf(currentStep);

  const handleNext = useCallback(() => {
    const nextIndex = currentIndex + 1;
    if (nextIndex < STEPS.length) {
      setCurrentStep(STEPS[nextIndex]);
    }
  }, [currentIndex]);

  const handleBack = useCallback(() => {
    const prevIndex = currentIndex - 1;
    if (prevIndex >= 0) {
      setCurrentStep(STEPS[prevIndex]);
    }
  }, [currentIndex]);

  const handleComplete = useCallback(async () => {
    try {
      await updateGeneral({ hasCompletedSetup: true });
      logger.info('Setup wizard completed');
      onComplete();
    } catch (error) {
      logger.error('Failed to save setup completion', { error });
      // Still call onComplete to not block the user
      onComplete();
    }
  }, [updateGeneral, onComplete]);

  const handleSkip = useCallback(async () => {
    try {
      await updateGeneral({ hasCompletedSetup: true });
      logger.info('Setup wizard skipped');
      onSkip?.();
    } catch (error) {
      logger.error('Failed to save setup skip', { error });
      onSkip?.();
    }
  }, [updateGeneral, onSkip]);

  // Sync completion when reaching complete step
  useEffect(() => {
    if (currentStep === 'complete') {
      // Mark as completed when reaching this step
      void updateGeneral({ hasCompletedSetup: true });
    }
  }, [currentStep, updateGeneral]);

  return (
    <div
      className="fixed inset-0 bg-editor-bg flex flex-col items-center justify-center"
      data-testid="setup-wizard"
    >
      {/* Progress indicator */}
      <div className="absolute top-8 flex items-center gap-2">
        {STEPS.slice(0, -1).map((step, index) => (
          <div
            key={step}
            className={`w-2 h-2 rounded-full transition-colors ${
              index <= currentIndex ? 'bg-primary-500' : 'bg-editor-border'
            }`}
          />
        ))}
      </div>

      {/* Version badge */}
      {version && (
        <div className="absolute top-8 right-8 text-xs text-editor-text-muted">
          v{version}
        </div>
      )}

      {/* Step content */}
      <div className="w-full max-w-xl">
        {currentStep === 'welcome' && (
          <WelcomeStep onNext={handleNext} onSkip={handleSkip} version={version} />
        )}
        {currentStep === 'ffmpeg' && (
          <FFmpegStep onNext={handleNext} onBack={handleBack} />
        )}
        {currentStep === 'settings' && (
          <SettingsStep onNext={handleNext} onBack={handleBack} />
        )}
        {currentStep === 'complete' && (
          <CompleteStep onComplete={() => void handleComplete()} />
        )}
      </div>
    </div>
  );
}

export default SetupWizard;
