/**
 * SetupWizard Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SetupWizard } from './SetupWizard';

// Mock hooks
vi.mock('@/hooks/useFFmpegStatus', () => ({
  useFFmpegStatus: vi.fn(() => ({
    status: null,
    isAvailable: true,
    isLoading: false,
    error: null,
    recheck: vi.fn(),
  })),
}));

vi.mock('@/hooks/useSettings', () => ({
  useSettings: vi.fn(() => ({
    settings: {
      version: 1,
      general: {
        language: 'en',
        showWelcomeOnStartup: true,
        hasCompletedSetup: false,
        recentProjectsLimit: 10,
        checkUpdatesOnStartup: false,
        defaultProjectLocation: null,
      },
      editor: {
        defaultTimelineZoom: 1,
        snapToGrid: true,
        snapTolerance: 10,
        showClipThumbnails: true,
        showAudioWaveforms: true,
        rippleEditDefault: false,
      },
      playback: {
        defaultVolume: 0.8,
        loopPlayback: false,
        previewQuality: 'auto',
        audioScrubbing: true,
      },
      export: {
        defaultFormat: 'mp4',
        defaultVideoCodec: 'h264',
        defaultAudioCodec: 'aac',
        defaultExportLocation: null,
        openFolderAfterExport: true,
      },
      appearance: {
        theme: 'dark',
        accentColor: '#3b82f6',
        uiScale: 1,
        showStatusBar: true,
        compactMode: false,
      },
      shortcuts: { customShortcuts: {} },
      autoSave: { enabled: true, intervalSeconds: 300, backupCount: 3 },
      performance: {
        hardwareAcceleration: true,
        proxyGeneration: true,
        proxyResolution: '720p',
        maxConcurrentJobs: 4,
        memoryLimitMb: 0,
        cacheSizeMb: 1024,
      },
      ai: {
        primaryProvider: 'anthropic',
        primaryModel: 'claude-sonnet-4-5-20251015',
        visionProvider: null,
        visionModel: null,
        openaiApiKey: null,
        anthropicApiKey: null,
        googleApiKey: null,
        ollamaUrl: null,
        temperature: 0.3,
        maxTokens: 4096,
        frameExtractionRate: 1.0,
        monthlyBudgetCents: null,
        perRequestLimitCents: 50,
        currentMonthUsageCents: 0,
        currentUsageMonth: null,
        autoAnalyzeOnImport: false,
        autoCaptionOnImport: false,
        proposalReviewMode: 'always',
        cacheDurationHours: 24,
        localOnlyMode: false, seedanceApiKey: null, videoGenProvider: null, videoGenDefaultQuality: 'pro', videoGenBudgetCents: null, videoGenPerRequestLimitCents: 100,
      },
    },
    appearance: {
      theme: 'dark' as const,
      accentColor: '#3b82f6',
      uiScale: 1,
      showStatusBar: true,
      compactMode: false,
    },
    general: {
      language: 'en',
      showWelcomeOnStartup: true,
      hasCompletedSetup: false,
      recentProjectsLimit: 10,
      checkUpdatesOnStartup: false,
      defaultProjectLocation: null,
    },
    editor: {
      defaultTimelineZoom: 1,
      snapToGrid: true,
      snapTolerance: 10,
      showClipThumbnails: true,
      showAudioWaveforms: true,
      rippleEditDefault: false,
    },
    playback: {
      defaultVolume: 0.8,
      loopPlayback: false,
      previewQuality: 'auto' as const,
      audioScrubbing: true,
    },
    export: {
      defaultFormat: 'mp4' as const,
      defaultVideoCodec: 'h264' as const,
      defaultAudioCodec: 'aac' as const,
      defaultExportLocation: null,
      openFolderAfterExport: true,
    },
    shortcuts: { customShortcuts: {} },
    autoSave: { enabled: true, intervalSeconds: 300, backupCount: 3 },
    performance: {
      hardwareAcceleration: true,
      proxyGeneration: true,
      proxyResolution: '720p' as const,
      maxConcurrentJobs: 4,
      memoryLimitMb: 0,
      cacheSizeMb: 1024,
    },
    loadSettings: vi.fn().mockResolvedValue(undefined),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    updateAppearance: vi.fn(),
    updateGeneral: vi.fn().mockResolvedValue(undefined),
    updateEditor: vi.fn().mockResolvedValue(undefined),
    updatePlayback: vi.fn().mockResolvedValue(undefined),
    updateExport: vi.fn().mockResolvedValue(undefined),
    updateShortcuts: vi.fn().mockResolvedValue(undefined),
    updateAutoSave: vi.fn().mockResolvedValue(undefined),
    updatePerformance: vi.fn().mockResolvedValue(undefined),
    resetSettings: vi.fn().mockResolvedValue(undefined),
    clearError: vi.fn(),
    isLoaded: true,
    isSaving: false,
    error: null,
  })),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

// =============================================================================
// Tests
// =============================================================================

describe('SetupWizard', () => {
  const mockOnComplete = vi.fn();
  const mockOnSkip = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render setup wizard', () => {
    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} version="0.1.0" />
    );

    expect(screen.getByTestId('setup-wizard')).toBeInTheDocument();
    expect(screen.getByText('Welcome to OpenReelio')).toBeInTheDocument();
  });

  it('should show version badge', () => {
    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} version="0.1.0" />
    );

    expect(screen.getByText('v0.1.0')).toBeInTheDocument();
  });

  it('should display welcome step initially', () => {
    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} />
    );

    expect(screen.getByText('Welcome to OpenReelio')).toBeInTheDocument();
    expect(screen.getByText('Get Started')).toBeInTheDocument();
    expect(screen.getByText('Skip Setup')).toBeInTheDocument();
  });

  it('should navigate to FFmpeg step when clicking Get Started', () => {
    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} />
    );

    fireEvent.click(screen.getByText('Get Started'));

    expect(screen.getByText('FFmpeg Setup')).toBeInTheDocument();
  });

  it('should allow skipping setup from welcome step', async () => {
    const { useSettings } = await import('@/hooks/useSettings');
    const mockUpdateGeneral = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useSettings).mockReturnValue({
      settings: {
        version: 1,
        general: { language: 'en', showWelcomeOnStartup: true, hasCompletedSetup: false, recentProjectsLimit: 10, checkUpdatesOnStartup: false, defaultProjectLocation: null },
        editor: { defaultTimelineZoom: 1, snapToGrid: true, snapTolerance: 10, showClipThumbnails: true, showAudioWaveforms: true, rippleEditDefault: false },
        playback: { defaultVolume: 0.8, loopPlayback: false, previewQuality: 'auto', audioScrubbing: true },
        export: { defaultFormat: 'mp4', defaultVideoCodec: 'h264', defaultAudioCodec: 'aac', defaultExportLocation: null, openFolderAfterExport: true },
        appearance: { theme: 'dark', accentColor: '#3b82f6', uiScale: 1, showStatusBar: true, compactMode: false },
        shortcuts: { customShortcuts: {} },
        autoSave: { enabled: true, intervalSeconds: 300, backupCount: 3 },
        performance: { hardwareAcceleration: true, proxyGeneration: true, proxyResolution: '720p', maxConcurrentJobs: 4, memoryLimitMb: 0, cacheSizeMb: 1024 },
        ai: { primaryProvider: 'anthropic', primaryModel: 'claude-sonnet-4-5-20251015', visionProvider: null, visionModel: null, openaiApiKey: null, anthropicApiKey: null, googleApiKey: null, ollamaUrl: null, temperature: 0.3, maxTokens: 4096, frameExtractionRate: 1.0, monthlyBudgetCents: null, perRequestLimitCents: 50, currentMonthUsageCents: 0, currentUsageMonth: null, autoAnalyzeOnImport: false, autoCaptionOnImport: false, proposalReviewMode: 'always', cacheDurationHours: 24, localOnlyMode: false, seedanceApiKey: null, videoGenProvider: null, videoGenDefaultQuality: 'pro', videoGenBudgetCents: null, videoGenPerRequestLimitCents: 100 },
      },
      appearance: { theme: 'dark' as const, accentColor: '#3b82f6', uiScale: 1, showStatusBar: true, compactMode: false },
      general: { language: 'en', showWelcomeOnStartup: true, hasCompletedSetup: false, recentProjectsLimit: 10, checkUpdatesOnStartup: false, defaultProjectLocation: null },
      loadSettings: vi.fn().mockResolvedValue(undefined),
      saveSettings: vi.fn().mockResolvedValue(undefined),
      updateAppearance: vi.fn(),
      updateGeneral: mockUpdateGeneral,
      isLoaded: true,
      isSaving: false,
      error: null,
      editor: { defaultTimelineZoom: 1, snapToGrid: true, snapTolerance: 10, showClipThumbnails: true, showAudioWaveforms: true, rippleEditDefault: false },
      playback: { defaultVolume: 0.8, loopPlayback: false, previewQuality: 'auto' as const, audioScrubbing: true },
      export: { defaultFormat: 'mp4' as const, defaultVideoCodec: 'h264' as const, defaultAudioCodec: 'aac' as const, defaultExportLocation: null, openFolderAfterExport: true },
      shortcuts: { customShortcuts: {} },
      autoSave: { enabled: true, intervalSeconds: 300, backupCount: 3 },
      performance: { hardwareAcceleration: true, proxyGeneration: true, proxyResolution: '720p' as const, maxConcurrentJobs: 4, memoryLimitMb: 0, cacheSizeMb: 1024 },
      updateEditor: vi.fn(),
      updatePlayback: vi.fn(),
      updateExport: vi.fn(),
      updateShortcuts: vi.fn(),
      updateAutoSave: vi.fn(),
      updatePerformance: vi.fn(),
      updateAI: vi.fn(),
      ai: { primaryProvider: 'anthropic' as const, primaryModel: 'claude-sonnet-4-5-20251015', visionProvider: null, visionModel: null, openaiApiKey: null, anthropicApiKey: null, googleApiKey: null, ollamaUrl: null, temperature: 0.3, maxTokens: 4096, frameExtractionRate: 1.0, monthlyBudgetCents: null, perRequestLimitCents: 50, currentMonthUsageCents: 0, currentUsageMonth: null, autoAnalyzeOnImport: false, autoCaptionOnImport: false, proposalReviewMode: 'always' as const, cacheDurationHours: 24, localOnlyMode: false, seedanceApiKey: null, videoGenProvider: null, videoGenDefaultQuality: 'pro', videoGenBudgetCents: null, videoGenPerRequestLimitCents: 100 },
      resetSettings: vi.fn(),
      clearError: vi.fn(),
    });

    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} />
    );

    fireEvent.click(screen.getByText('Skip Setup'));

    await waitFor(() => {
      expect(mockUpdateGeneral).toHaveBeenCalledWith({ hasCompletedSetup: true });
    });
  });

  it('should navigate back from FFmpeg step', () => {
    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} />
    );

    // Go to FFmpeg step
    fireEvent.click(screen.getByText('Get Started'));
    expect(screen.getByText('FFmpeg Setup')).toBeInTheDocument();

    // Go back
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByText('Welcome to OpenReelio')).toBeInTheDocument();
  });

  it('should navigate through all steps', () => {
    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} />
    );

    // Welcome -> FFmpeg
    fireEvent.click(screen.getByText('Get Started'));
    expect(screen.getByText('FFmpeg Setup')).toBeInTheDocument();

    // FFmpeg -> Settings
    fireEvent.click(screen.getByText('Continue'));
    expect(screen.getByText('Preferences')).toBeInTheDocument();

    // Settings -> Complete
    fireEvent.click(screen.getByText('Continue'));
    expect(screen.getByText("You're All Set!")).toBeInTheDocument();
  });

  it('should show FFmpeg found message when available', () => {
    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} />
    );

    fireEvent.click(screen.getByText('Get Started'));

    expect(screen.getByText('FFmpeg Found')).toBeInTheDocument();
    expect(screen.getByText('Video processing is ready to use.')).toBeInTheDocument();
  });

  it('should show FFmpeg not found message when unavailable', async () => {
    const { useFFmpegStatus } = await import('@/hooks/useFFmpegStatus');
    vi.mocked(useFFmpegStatus).mockReturnValue({
      status: null,
      isAvailable: false,
      isLoading: false,
      error: 'FFmpeg not found in PATH',
      recheck: vi.fn(),
    });

    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} />
    );

    fireEvent.click(screen.getByText('Get Started'));

    expect(screen.getByText('FFmpeg Not Found')).toBeInTheDocument();
    expect(screen.getByText('Continue Anyway')).toBeInTheDocument();
  });

  it('should show loading state while checking FFmpeg', async () => {
    const { useFFmpegStatus } = await import('@/hooks/useFFmpegStatus');
    vi.mocked(useFFmpegStatus).mockReturnValue({
      status: null,
      isAvailable: false,
      isLoading: true,
      error: null,
      recheck: vi.fn(),
    });

    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} />
    );

    fireEvent.click(screen.getByText('Get Started'));

    expect(screen.getByText('Checking FFmpeg...')).toBeInTheDocument();
  });

  it('should show theme selection in settings step', () => {
    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} />
    );

    // Navigate to settings
    fireEvent.click(screen.getByText('Get Started'));
    fireEvent.click(screen.getByText('Continue'));

    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByText('dark')).toBeInTheDocument();
    expect(screen.getByText('light')).toBeInTheDocument();
    expect(screen.getByText('system')).toBeInTheDocument();
  });

  it('should show completion step with tips', () => {
    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} />
    );

    // Navigate to complete
    fireEvent.click(screen.getByText('Get Started'));
    fireEvent.click(screen.getByText('Continue'));
    fireEvent.click(screen.getByText('Continue'));

    expect(screen.getByText("You're All Set!")).toBeInTheDocument();
    expect(screen.getByText('Quick Tips:')).toBeInTheDocument();
    expect(screen.getByText('Start Editing')).toBeInTheDocument();
  });

  it('should call onComplete when clicking Start Editing', async () => {
    const { useSettings } = await import('@/hooks/useSettings');
    const mockUpdateGeneral = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useSettings).mockReturnValue({
      settings: {
        version: 1,
        general: { language: 'en', showWelcomeOnStartup: true, hasCompletedSetup: false, recentProjectsLimit: 10, checkUpdatesOnStartup: false, defaultProjectLocation: null },
        editor: { defaultTimelineZoom: 1, snapToGrid: true, snapTolerance: 10, showClipThumbnails: true, showAudioWaveforms: true, rippleEditDefault: false },
        playback: { defaultVolume: 0.8, loopPlayback: false, previewQuality: 'auto', audioScrubbing: true },
        export: { defaultFormat: 'mp4', defaultVideoCodec: 'h264', defaultAudioCodec: 'aac', defaultExportLocation: null, openFolderAfterExport: true },
        appearance: { theme: 'dark', accentColor: '#3b82f6', uiScale: 1, showStatusBar: true, compactMode: false },
        shortcuts: { customShortcuts: {} },
        autoSave: { enabled: true, intervalSeconds: 300, backupCount: 3 },
        performance: { hardwareAcceleration: true, proxyGeneration: true, proxyResolution: '720p', maxConcurrentJobs: 4, memoryLimitMb: 0, cacheSizeMb: 1024 },
        ai: { primaryProvider: 'anthropic', primaryModel: 'claude-sonnet-4-5-20251015', visionProvider: null, visionModel: null, openaiApiKey: null, anthropicApiKey: null, googleApiKey: null, ollamaUrl: null, temperature: 0.3, maxTokens: 4096, frameExtractionRate: 1.0, monthlyBudgetCents: null, perRequestLimitCents: 50, currentMonthUsageCents: 0, currentUsageMonth: null, autoAnalyzeOnImport: false, autoCaptionOnImport: false, proposalReviewMode: 'always', cacheDurationHours: 24, localOnlyMode: false, seedanceApiKey: null, videoGenProvider: null, videoGenDefaultQuality: 'pro', videoGenBudgetCents: null, videoGenPerRequestLimitCents: 100 },
      },
      appearance: { theme: 'dark' as const, accentColor: '#3b82f6', uiScale: 1, showStatusBar: true, compactMode: false },
      general: { language: 'en', showWelcomeOnStartup: true, hasCompletedSetup: false, recentProjectsLimit: 10, checkUpdatesOnStartup: false, defaultProjectLocation: null },
      loadSettings: vi.fn().mockResolvedValue(undefined),
      saveSettings: vi.fn().mockResolvedValue(undefined),
      updateAppearance: vi.fn(),
      updateGeneral: mockUpdateGeneral,
      isLoaded: true,
      isSaving: false,
      error: null,
      editor: { defaultTimelineZoom: 1, snapToGrid: true, snapTolerance: 10, showClipThumbnails: true, showAudioWaveforms: true, rippleEditDefault: false },
      playback: { defaultVolume: 0.8, loopPlayback: false, previewQuality: 'auto' as const, audioScrubbing: true },
      export: { defaultFormat: 'mp4' as const, defaultVideoCodec: 'h264' as const, defaultAudioCodec: 'aac' as const, defaultExportLocation: null, openFolderAfterExport: true },
      shortcuts: { customShortcuts: {} },
      autoSave: { enabled: true, intervalSeconds: 300, backupCount: 3 },
      performance: { hardwareAcceleration: true, proxyGeneration: true, proxyResolution: '720p' as const, maxConcurrentJobs: 4, memoryLimitMb: 0, cacheSizeMb: 1024 },
      updateEditor: vi.fn(),
      updatePlayback: vi.fn(),
      updateExport: vi.fn(),
      updateShortcuts: vi.fn(),
      updateAutoSave: vi.fn(),
      updatePerformance: vi.fn(),
      updateAI: vi.fn(),
      ai: { primaryProvider: 'anthropic' as const, primaryModel: 'claude-sonnet-4-5-20251015', visionProvider: null, visionModel: null, openaiApiKey: null, anthropicApiKey: null, googleApiKey: null, ollamaUrl: null, temperature: 0.3, maxTokens: 4096, frameExtractionRate: 1.0, monthlyBudgetCents: null, perRequestLimitCents: 50, currentMonthUsageCents: 0, currentUsageMonth: null, autoAnalyzeOnImport: false, autoCaptionOnImport: false, proposalReviewMode: 'always' as const, cacheDurationHours: 24, localOnlyMode: false, seedanceApiKey: null, videoGenProvider: null, videoGenDefaultQuality: 'pro', videoGenBudgetCents: null, videoGenPerRequestLimitCents: 100 },
      resetSettings: vi.fn(),
      clearError: vi.fn(),
    });

    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} />
    );

    // Navigate to complete and click Start Editing
    fireEvent.click(screen.getByText('Get Started'));
    fireEvent.click(screen.getByText('Continue'));
    fireEvent.click(screen.getByText('Continue'));
    fireEvent.click(screen.getByText('Start Editing'));

    await waitFor(() => {
      expect(mockOnComplete).toHaveBeenCalled();
    });
  });

  it('should show progress indicators', () => {
    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} />
    );

    // There should be 3 progress dots (welcome, ffmpeg, settings - not complete)
    // Progress dots are 2x2 rounded-full elements inside the top-8 container
    const progressContainer = document.querySelector('.top-8.flex.items-center.gap-2');
    const progressDots = progressContainer?.querySelectorAll('.rounded-full');
    expect(progressDots).toHaveLength(3);
  });

  it('should highlight current step in progress indicator', () => {
    render(
      <SetupWizard onComplete={mockOnComplete} onSkip={mockOnSkip} />
    );

    // First dot should be highlighted (primary color)
    const progressDots = document.querySelectorAll('[class*="rounded-full"][class*="w-2"]');
    expect(progressDots[0]).toHaveClass('bg-primary-500');
  });
});

describe('SetupWizard FFmpeg step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should have Check Again button when FFmpeg not found', async () => {
    const { useFFmpegStatus } = await import('@/hooks/useFFmpegStatus');
    const mockRecheck = vi.fn();
    vi.mocked(useFFmpegStatus).mockReturnValue({
      status: null,
      isAvailable: false,
      isLoading: false,
      error: null,
      recheck: mockRecheck,
    });

    render(
      <SetupWizard onComplete={vi.fn()} onSkip={vi.fn()} />
    );

    fireEvent.click(screen.getByText('Get Started'));
    fireEvent.click(screen.getByText('Check Again'));

    expect(mockRecheck).toHaveBeenCalled();
  });
});

describe('SetupWizard settings step', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should allow changing theme', async () => {
    const { useSettings } = await import('@/hooks/useSettings');
    const mockUpdateAppearance = vi.fn();
    vi.mocked(useSettings).mockReturnValue({
      settings: {
        version: 1,
        general: { language: 'en', showWelcomeOnStartup: true, hasCompletedSetup: false, recentProjectsLimit: 10, checkUpdatesOnStartup: false, defaultProjectLocation: null },
        editor: { defaultTimelineZoom: 1, snapToGrid: true, snapTolerance: 10, showClipThumbnails: true, showAudioWaveforms: true, rippleEditDefault: false },
        playback: { defaultVolume: 0.8, loopPlayback: false, previewQuality: 'auto', audioScrubbing: true },
        export: { defaultFormat: 'mp4', defaultVideoCodec: 'h264', defaultAudioCodec: 'aac', defaultExportLocation: null, openFolderAfterExport: true },
        appearance: { theme: 'dark', accentColor: '#3b82f6', uiScale: 1, showStatusBar: true, compactMode: false },
        shortcuts: { customShortcuts: {} },
        autoSave: { enabled: true, intervalSeconds: 300, backupCount: 3 },
        performance: { hardwareAcceleration: true, proxyGeneration: true, proxyResolution: '720p', maxConcurrentJobs: 4, memoryLimitMb: 0, cacheSizeMb: 1024 },
        ai: { primaryProvider: 'anthropic', primaryModel: 'claude-sonnet-4-5-20251015', visionProvider: null, visionModel: null, openaiApiKey: null, anthropicApiKey: null, googleApiKey: null, ollamaUrl: null, temperature: 0.3, maxTokens: 4096, frameExtractionRate: 1.0, monthlyBudgetCents: null, perRequestLimitCents: 50, currentMonthUsageCents: 0, currentUsageMonth: null, autoAnalyzeOnImport: false, autoCaptionOnImport: false, proposalReviewMode: 'always', cacheDurationHours: 24, localOnlyMode: false, seedanceApiKey: null, videoGenProvider: null, videoGenDefaultQuality: 'pro', videoGenBudgetCents: null, videoGenPerRequestLimitCents: 100 },
      },
      appearance: { theme: 'dark' as const, accentColor: '#3b82f6', uiScale: 1, showStatusBar: true, compactMode: false },
      general: { language: 'en', showWelcomeOnStartup: true, hasCompletedSetup: false, recentProjectsLimit: 10, checkUpdatesOnStartup: false, defaultProjectLocation: null },
      loadSettings: vi.fn().mockResolvedValue(undefined),
      saveSettings: vi.fn().mockResolvedValue(undefined),
      updateAppearance: mockUpdateAppearance,
      updateGeneral: vi.fn().mockResolvedValue(undefined),
      isLoaded: true,
      isSaving: false,
      error: null,
      editor: { defaultTimelineZoom: 1, snapToGrid: true, snapTolerance: 10, showClipThumbnails: true, showAudioWaveforms: true, rippleEditDefault: false },
      playback: { defaultVolume: 0.8, loopPlayback: false, previewQuality: 'auto' as const, audioScrubbing: true },
      export: { defaultFormat: 'mp4' as const, defaultVideoCodec: 'h264' as const, defaultAudioCodec: 'aac' as const, defaultExportLocation: null, openFolderAfterExport: true },
      shortcuts: { customShortcuts: {} },
      autoSave: { enabled: true, intervalSeconds: 300, backupCount: 3 },
      performance: { hardwareAcceleration: true, proxyGeneration: true, proxyResolution: '720p' as const, maxConcurrentJobs: 4, memoryLimitMb: 0, cacheSizeMb: 1024 },
      updateEditor: vi.fn(),
      updatePlayback: vi.fn(),
      updateExport: vi.fn(),
      updateShortcuts: vi.fn(),
      updateAutoSave: vi.fn(),
      updatePerformance: vi.fn(),
      updateAI: vi.fn(),
      ai: { primaryProvider: 'anthropic' as const, primaryModel: 'claude-sonnet-4-5-20251015', visionProvider: null, visionModel: null, openaiApiKey: null, anthropicApiKey: null, googleApiKey: null, ollamaUrl: null, temperature: 0.3, maxTokens: 4096, frameExtractionRate: 1.0, monthlyBudgetCents: null, perRequestLimitCents: 50, currentMonthUsageCents: 0, currentUsageMonth: null, autoAnalyzeOnImport: false, autoCaptionOnImport: false, proposalReviewMode: 'always' as const, cacheDurationHours: 24, localOnlyMode: false, seedanceApiKey: null, videoGenProvider: null, videoGenDefaultQuality: 'pro', videoGenBudgetCents: null, videoGenPerRequestLimitCents: 100 },
      resetSettings: vi.fn(),
      clearError: vi.fn(),
    });

    render(
      <SetupWizard onComplete={vi.fn()} onSkip={vi.fn()} />
    );

    // Navigate to settings
    fireEvent.click(screen.getByText('Get Started'));
    fireEvent.click(screen.getByText('Continue'));

    // Click light theme
    fireEvent.click(screen.getByText('light'));

    expect(mockUpdateAppearance).toHaveBeenCalledWith({ theme: 'light' });
  });
});
