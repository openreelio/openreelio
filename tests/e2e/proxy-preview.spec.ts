import { test, expect, type Page } from '@playwright/test';

async function dismissBlockingFFmpegWarning(page: Page): Promise<void> {
  const warning = page.locator('[data-testid="ffmpeg-warning"]');
  if (!(await warning.isVisible().catch(() => false))) {
    return;
  }

  const dismissButton = warning.locator('[data-testid="ffmpeg-warning-dismiss"]');
  if (await dismissButton.isVisible().catch(() => false)) {
    await dismissButton.click();
  } else {
    const backdrop = page.locator('[data-testid="ffmpeg-warning-backdrop"]');
    if (await backdrop.isVisible().catch(() => false)) {
      await backdrop.click({ position: { x: 8, y: 8 } });
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  await expect(warning).toBeHidden({ timeout: 10000 });
}

async function seedProxyPreviewState(page: Page): Promise<void> {
  const origin = new URL(page.url()).origin;
  await page.evaluate(async (baseUrl) => {
    const { useProjectStore } = await import('../../src/stores/projectStore.ts');
    const { usePlaybackStore } = await import('../../src/stores/playbackStore.ts');

    const now = new Date().toISOString();
    const fixtureBase = `${baseUrl}/tests/e2e/fixtures`;

    const asset = {
      id: 'asset_proxy_qa_1',
      kind: 'video',
      name: 'sample-video.mp4',
      uri: `${fixtureBase}/sample-video.mp4`,
      hash: 'proxy-qa-hash',
      fileSize: 1024,
      durationSec: 10,
      importedAt: now,
      video: {
        width: 1280,
        height: 720,
        fps: { num: 30, den: 1 },
        codec: 'h264',
        hasAlpha: false,
      },
      license: {
        source: 'user',
        licenseType: 'unknown',
        allowedUse: [],
      },
      tags: [],
      proxyStatus: 'ready',
      proxyUrl: `${fixtureBase}/sample-video.mp4`,
    };

    const clip = {
      id: 'clip_proxy_qa_1',
      assetId: asset.id,
      range: { sourceInSec: 0, sourceOutSec: 5 },
      place: { timelineInSec: 0, durationSec: 5 },
      transform: {
        position: { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
        rotationDeg: 0,
        anchor: { x: 0.5, y: 0.5 },
      },
      opacity: 1,
      speed: 1,
      effects: [],
      audio: { volumeDb: 0, pan: 0, muted: false },
    };

    const sequence = {
      id: 'seq_proxy_qa_1',
      name: 'Proxy QA Sequence',
      format: {
        canvas: { width: 1280, height: 720 },
        fps: { num: 30, den: 1 },
        audioSampleRate: 48000,
        audioChannels: 2,
      },
      tracks: [
        {
          id: 'track_video_qa_1',
          kind: 'video',
          name: 'Video 1',
          clips: [clip],
          blendMode: 'normal',
          muted: false,
          locked: false,
          visible: true,
          volume: 1,
        },
        {
          id: 'track_audio_qa_1',
          kind: 'audio',
          name: 'Audio 1',
          clips: [],
          blendMode: 'normal',
          muted: false,
          locked: false,
          visible: true,
          volume: 1,
        },
      ],
      markers: [],
    };

    useProjectStore.setState({
      isLoaded: true,
      isLoading: false,
      isDirty: false,
      meta: {
        id: 'project_proxy_qa_1',
        name: 'Proxy QA Project',
        path: '/tmp/proxy-qa',
        createdAt: now,
        modifiedAt: now,
      },
      assets: new Map([[asset.id, asset]]),
      sequences: new Map([[sequence.id, sequence]]),
      activeSequenceId: sequence.id,
      selectedAssetId: asset.id,
      error: null,
    });

    usePlaybackStore.setState({
      currentTime: 0,
      duration: 8,
      isPlaying: false,
      playbackRate: 1,
      volume: 1,
      isMuted: false,
      loop: false,
      syncWithTimeline: true,
    });
  }, origin);
}

test.describe('Proxy Preview QA', () => {
  test('renders in proxy mode and keeps playback responsive', async ({ page }) => {
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        pageErrors.push(msg.text());
      }
    });

    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await dismissBlockingFFmpegWarning(page);
    await seedProxyPreviewState(page);
    await dismissBlockingFFmpegWarning(page);

    const player = page.locator('[data-testid="unified-preview-player"]');
    await expect(player).toBeVisible();
    await expect(player).toHaveAttribute('data-mode', 'video');

    const proxyVideo = page.locator('[data-testid="proxy-video-clip_proxy_qa_1"]');
    await expect(proxyVideo).toBeVisible();
    await expect(page.locator('[data-testid^="proxy-video-error-"]')).toHaveCount(0);

    const source = await proxyVideo.getAttribute('src');
    expect(source).toContain('sample-video.mp4');

    await page.evaluate(async () => {
      const { usePlaybackStore } = await import('../../src/stores/playbackStore.ts');
      usePlaybackStore.getState().seek(2.5, 'proxy-qa-seek');
    });

    await page.waitForTimeout(200);
    const videoTimeAfterSeek = await proxyVideo.evaluate(
      (el) => (el as HTMLVideoElement).currentTime,
    );
    expect(Math.abs(videoTimeAfterSeek - 2.5)).toBeLessThanOrEqual(0.2);

    const readPlaybackSnapshot = async () =>
      page.evaluate(async () => {
        const { usePlaybackStore } = await import('../../src/stores/playbackStore.ts');
        const state = usePlaybackStore.getState();
        return { currentTime: state.currentTime, isPlaying: state.isPlaying };
      });

    const beforePlay = await readPlaybackSnapshot();
    expect(beforePlay.isPlaying).toBe(false);
    expect(beforePlay.currentTime).toBeGreaterThanOrEqual(0);

    await page.click('[data-testid="play-button"]');
    await expect(page.locator('[data-testid="pause-button"]')).toBeVisible();

    await page.waitForTimeout(700);
    const afterPlay = await readPlaybackSnapshot();

    expect(afterPlay.isPlaying).toBe(true);
    expect(afterPlay.currentTime).toBeGreaterThan(0.1);

    await page.click('[data-testid="pause-button"]');
    const afterPause = await readPlaybackSnapshot();
    expect(afterPause.isPlaying).toBe(false);

    await page.waitForTimeout(300);
    const afterPauseSettled = await readPlaybackSnapshot();
    expect(Math.abs(afterPauseSettled.currentTime - afterPause.currentTime)).toBeLessThanOrEqual(
      0.1,
    );

    // Console/Page errors are allowed only for benign React warnings.
    const criticalErrors = pageErrors.filter(
      (entry) =>
        !entry.startsWith('Warning:') &&
        !/^Warning: /.test(entry) &&
        !entry.includes('ReactDOM') &&
        !entry.includes('react-dom') &&
        !entry.includes('ResizeObserver') &&
        !entry.includes('[AIStore] Failed to sync AI provider from vault') &&
        !entry.includes('[FrameExtractor] Frame extraction error'),
    );
    expect(criticalErrors).toEqual([]);
  });
});
