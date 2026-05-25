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
    await page.keyboard.press('Escape').catch(() => {});
  }

  await expect(warning).toBeHidden({ timeout: 10000 });
}

async function waitForE2eHooks(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__OPENREELIO_E2E__), null, {
    timeout: 30000,
  });
}

async function seedTextEditingState(page: Page): Promise<void> {
  await page.evaluate(() => {
    const now = new Date().toISOString();
    const sequence = {
      id: 'seq_text_e2e_1',
      name: 'Text Editing QA Sequence',
      format: {
        canvas: { width: 1920, height: 1080 },
        fps: { num: 30, den: 1 },
        audioSampleRate: 48000,
        audioChannels: 2,
      },
      tracks: [],
      markers: [],
    };

    const hooks = window.__OPENREELIO_E2E__;
    if (!hooks) {
      throw new Error('OpenReelio E2E hooks are not available in this build.');
    }

    hooks.seedProxyPreviewState({
      project: {
        id: 'project_text_e2e_1',
        name: 'Text Editing QA Project',
        path: '/tmp/text-editing-qa',
        createdAt: now,
        modifiedAt: now,
      },
      assets: [],
      sequences: [sequence],
      effects: [],
      activeSequenceId: sequence.id,
      selectedAssetId: null,
      enableInMemoryCommands: true,
      playback: {
        currentTime: 0,
        duration: 8,
        isPlaying: false,
        playbackRate: 1,
        volume: 1,
        isMuted: false,
        loop: false,
        syncWithTimeline: true,
      },
      activePanel: { zoneId: 'center-top', panelId: 'program-monitor' },
    });
  });
}

test.describe('Text Editing QA', () => {
  async function countBrightCanvasPixelsNear(
    page: Page,
    xRatio: number,
    yRatio: number,
  ): Promise<number> {
    return page.evaluate(
      ({ xRatio: x, yRatio: y }) => {
        const canvas = document.querySelector(
          '[data-testid="preview-canvas"]',
        ) as HTMLCanvasElement | null;
        if (!canvas) return 0;

        const context = canvas.getContext('2d');
        if (!context) return 0;

        const sampleSize = 160;
        const startX = Math.max(0, Math.floor(canvas.width * x - sampleSize / 2));
        const startY = Math.max(0, Math.floor(canvas.height * y - sampleSize / 2));
        const width = Math.min(sampleSize, canvas.width - startX);
        const height = Math.min(sampleSize, canvas.height - startY);
        const image = context.getImageData(startX, startY, width, height).data;
        let bright = 0;
        for (let index = 0; index < image.length; index += 4) {
          if (image[index + 3] > 0 && image[index] + image[index + 1] + image[index + 2] > 80) {
            bright += 1;
          }
        }
        return bright;
      },
      { xRatio, yRatio },
    );
  }

  test('places text in the preview, creates a timeline clip, edits it in inspector, drags it, and resizes it', async ({
    page,
  }) => {
    test.setTimeout(240000);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');
    await dismissBlockingFFmpegWarning(page);
    await waitForE2eHooks(page);
    await seedTextEditingState(page);
    await dismissBlockingFFmpegWarning(page);

    const player = page.locator('[data-testid="timeline-preview-player"]');
    await expect(player).toBeVisible({ timeout: 120000 });

    await page.locator('[data-testid="add-text-button"]').first().click();
    const placementOverlay = page.locator('[data-testid="text-placement-overlay"]');
    await expect(placementOverlay).toBeVisible();

    const overlayBox = await placementOverlay.boundingBox();
    if (!overlayBox) {
      throw new Error('Text placement overlay has no bounding box.');
    }

    await placementOverlay.click({
      position: {
        x: overlayBox.width * 0.38,
        y: overlayBox.height * 0.42,
      },
    });
    const placementInput = page.locator('[data-testid="text-placement-input"]');
    await expect(placementInput).toBeVisible();
    await placementInput.fill('E2E Overlay');
    await placementInput.press('Enter');

    await expect(page.locator('[data-testid^="clip-"]').first()).toBeVisible();

    const projectAfterAdd = await page.evaluate(() => {
      const hooks = window.__OPENREELIO_E2E__;
      if (!hooks) throw new Error('E2E hooks unavailable.');
      return hooks.readProjectSnapshot();
    });
    expect(projectAfterAdd.effectCount).toBe(1);
    expect(projectAfterAdd.trackCount).toBe(1);
    expect(projectAfterAdd.clipCount).toBe(1);
    expect(projectAfterAdd.selectedClipIds).toHaveLength(1);
    expect(projectAfterAdd.selectedClipTransform?.position.x).toBeGreaterThan(0.3);

    await expect(page.locator('[data-testid="text-inspector"]')).toBeVisible({ timeout: 10000 });
    const contentInput = page.locator('[data-testid="text-content-input"]');
    await expect(contentInput).toHaveValue('E2E Overlay');
    await expect
      .poll(
        async () => {
          const domTextCount = await page
            .locator('[data-testid^="proxy-text-overlay-"]')
            .filter({ hasText: 'E2E Overlay' })
            .count();
          if (domTextCount > 0) return 1;

          return (await countBrightCanvasPixelsNear(page, 0.38, 0.42)) > 10 ? 1 : 0;
        },
        { timeout: 10000 },
      )
      .toBe(1);
    await contentInput.fill('Edited E2E Overlay');
    await expect(contentInput).toHaveValue('Edited E2E Overlay');

    const inspector = page.locator('[data-testid="text-inspector"]');
    await inspector.getByText('Timing').click();
    await inspector.getByLabel('Start').fill('1.25');
    await inspector.getByLabel('Duration').fill('4.5');

    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const hooks = window.__OPENREELIO_E2E__;
          if (!hooks) throw new Error('E2E hooks unavailable.');
          const timing = hooks.readProjectSnapshot().selectedClipTiming;
          return timing
            ? `${timing.timelineInSec.toFixed(2)}:${timing.durationSec.toFixed(2)}`
            : '';
        });
      })
      .toBe('1.25:4.50');

    const beforeDrag = await page.evaluate(() => {
      const hooks = window.__OPENREELIO_E2E__;
      if (!hooks) throw new Error('E2E hooks unavailable.');
      return hooks.readProjectSnapshot().selectedClipTransform;
    });
    if (!beforeDrag) throw new Error('Selected text clip has no transform before dragging.');

    const transformBounds = page.locator('[data-testid="transform-bounds"]');
    await expect(transformBounds).toBeVisible({ timeout: 10000 });
    const boundsBox = await transformBounds.boundingBox();
    if (!boundsBox) {
      throw new Error('Transform bounds have no bounding box.');
    }

    await page.mouse.move(boundsBox.x + boundsBox.width / 2, boundsBox.y + boundsBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      boundsBox.x + boundsBox.width / 2 + 90,
      boundsBox.y + boundsBox.height / 2 + 40,
      { steps: 8 },
    );
    await page.mouse.up();

    await expect
      .poll(async () => {
        const afterDrag = await page.evaluate(() => {
          const hooks = window.__OPENREELIO_E2E__;
          if (!hooks) throw new Error('E2E hooks unavailable.');
          return hooks.readProjectSnapshot().selectedClipTransform;
        });
        return afterDrag ? afterDrag.position.x - beforeDrag.position.x : 0;
      })
      .toBeGreaterThan(0.02);

    const beforeResize = await page.evaluate(() => {
      const hooks = window.__OPENREELIO_E2E__;
      if (!hooks) throw new Error('E2E hooks unavailable.');
      return hooks.readProjectSnapshot().selectedClipTransform;
    });
    if (!beforeResize) throw new Error('Selected text clip has no transform before resizing.');

    const resizeHandle = page.locator('[data-testid="transform-handle-bottom-right"]');
    await expect(resizeHandle).toBeVisible({ timeout: 10000 });
    const resizeHandleBox = await resizeHandle.boundingBox();
    if (!resizeHandleBox) {
      throw new Error('Transform resize handle has no bounding box.');
    }

    await page.mouse.move(
      resizeHandleBox.x + resizeHandleBox.width / 2,
      resizeHandleBox.y + resizeHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      resizeHandleBox.x + resizeHandleBox.width / 2 + 90,
      resizeHandleBox.y + resizeHandleBox.height / 2 + 50,
      { steps: 8 },
    );
    await page.mouse.up();

    await expect
      .poll(async () => {
        const afterResize = await page.evaluate(() => {
          const hooks = window.__OPENREELIO_E2E__;
          if (!hooks) throw new Error('E2E hooks unavailable.');
          return hooks.readProjectSnapshot().selectedClipTransform;
        });
        return afterResize ? afterResize.scale.x - beforeResize.scale.x : 0;
      })
      .toBeGreaterThan(0.02);
  });
});
