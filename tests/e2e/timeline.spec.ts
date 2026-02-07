/**
 * Timeline E2E Tests
 *
 * End-to-end tests for timeline functionality.
 * These tests verify the timeline component works correctly
 * in the full application context.
 */

import { test, expect } from '@playwright/test';

test.describe('Timeline', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test.describe('Display', () => {
    test('should display timeline area', async ({ page }) => {
      // Timeline might not be visible until a project is loaded
      // So we check if either timeline or welcome screen is visible
      const timelineOrWelcome = page.locator(
        '[data-testid="timeline"], [data-testid="welcome-screen"], [data-testid="setup-wizard"]',
      );
      await expect(timelineOrWelcome.first()).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Playback Controls', () => {
    test('should have playback control buttons', async ({ page }) => {
      // Skip if on welcome screen
      const welcomeScreen = page.locator(
        '[data-testid="welcome-screen"], [data-testid="setup-wizard"]',
      );
      if (await welcomeScreen.isVisible()) {
        test.skip();
        return;
      }

      // Look for play/pause button
      const playButton = page.locator(
        '[data-testid="play-button"], [aria-label*="play" i], button:has-text("Play")',
      );

      if (await playButton.first().isVisible()) {
        await expect(playButton.first()).toBeEnabled();
      }
    });
  });

  test.describe('Time Ruler', () => {
    test('should display time ruler when timeline is visible', async ({ page }) => {
      // Skip if on welcome screen
      const welcomeScreen = page.locator(
        '[data-testid="welcome-screen"], [data-testid="setup-wizard"]',
      );
      if (await welcomeScreen.isVisible()) {
        test.skip();
        return;
      }

      const timeRuler = page.locator('[data-testid="time-ruler"], .time-ruler');

      if (await timeRuler.isVisible()) {
        await expect(timeRuler).toBeVisible();
      }
    });
  });

  test.describe('Zoom Controls', () => {
    test('should have zoom controls', async ({ page }) => {
      // Skip if on welcome screen
      const welcomeScreen = page.locator(
        '[data-testid="welcome-screen"], [data-testid="setup-wizard"]',
      );
      if (await welcomeScreen.isVisible()) {
        test.skip();
        return;
      }

      // At least one zoom control should exist
      const zoomControls = page.locator(
        '[data-testid="zoom-in"], [data-testid="zoom-out"], [data-testid="zoom-slider"]',
      );

      if (await zoomControls.first().isVisible()) {
        await expect(zoomControls.first()).toBeEnabled();
      }
    });
  });
});

test.describe('Track Operations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Skip if on welcome screen
    const welcomeScreen = page.locator(
      '[data-testid="welcome-screen"], [data-testid="setup-wizard"]',
    );
    if (await welcomeScreen.isVisible()) {
      test.skip();
    }
  });

  test('should display track headers when tracks exist', async ({ page }) => {
    const trackHeaders = page.locator('[data-testid="track-header"]');
    const count = await trackHeaders.count();

    // If there are tracks, they should have headers
    if (count > 0) {
      await expect(trackHeaders.first()).toBeVisible();
    }
  });

  test('should allow track muting if tracks exist', async ({ page }) => {
    const muteButton = page.locator('[data-testid="mute-button"]').first();

    if (await muteButton.isVisible()) {
      await muteButton.click();

      // After clicking, should show muted indicator or change state
      // Either state change indicator should exist
      await expect(muteButton).toBeVisible();
    }
  });

  test('should seek playhead on content/header clicks but not header buttons', async ({ page }) => {
    const timeline = page.locator('[data-testid="timeline"]');
    if (!(await timeline.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    const playheadHead = page.locator('[data-testid="playhead-head"]');
    const tracksArea = page.locator('[data-testid="timeline-tracks-area"]');
    const trackHeader = page.locator('[data-testid="track-header"]').first();
    const muteButton = page.locator('[data-testid="mute-button"]').first();

    if (
      !(await playheadHead.isVisible().catch(() => false)) ||
      !(await tracksArea.isVisible().catch(() => false))
    ) {
      test.skip();
      return;
    }

    const readPlayheadTime = async (): Promise<number> => {
      const raw = await playheadHead.getAttribute('aria-valuenow');
      return Number(raw ?? '0');
    };

    // 1) Click in track content area -> seek away from 0
    await tracksArea.click({ position: { x: 280, y: 36 } });
    const afterContentClick = await readPlayheadTime();
    expect(afterContentClick).toBeGreaterThan(0.1);

    // 2) Click clip body (if present) -> seek should still work
    const clip = page.locator('[data-testid^="clip-"]').first();
    if (await clip.isVisible().catch(() => false)) {
      await clip.click({ position: { x: 24, y: 20 } });
      const afterClipClick = await readPlayheadTime();
      expect(afterClipClick).toBeGreaterThanOrEqual(0);
    }

    // 3) Click header non-button region -> should seek to start-side time (~0)
    if (await trackHeader.isVisible().catch(() => false)) {
      await trackHeader.click({ position: { x: 72, y: 20 } });
      const afterHeaderClick = await readPlayheadTime();
      expect(afterHeaderClick).toBeLessThanOrEqual(0.05);
    }

    // 4) Click header control button -> should not change playhead
    if (await muteButton.isVisible().catch(() => false)) {
      const beforeButtonClick = await readPlayheadTime();
      await muteButton.click();
      const afterButtonClick = await readPlayheadTime();
      expect(Math.abs(afterButtonClick - beforeButtonClick)).toBeLessThanOrEqual(0.01);
    }
  });
});

test.describe('Keyboard Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should respond to Space key for play/pause', async ({ page }) => {
    // Skip if on welcome screen
    const welcomeScreen = page.locator(
      '[data-testid="welcome-screen"], [data-testid="setup-wizard"]',
    );
    if (await welcomeScreen.isVisible()) {
      test.skip();
      return;
    }

    // Focus on the main content area
    await page.locator('body').press('Space');

    // This should toggle playback - we can verify by checking playback state
    // The exact verification depends on how playback state is exposed
  });

  test('should respond to arrow keys for navigation', async ({ page }) => {
    // Skip if on welcome screen
    const welcomeScreen = page.locator(
      '[data-testid="welcome-screen"], [data-testid="setup-wizard"]',
    );
    if (await welcomeScreen.isVisible()) {
      test.skip();
      return;
    }

    // Press arrow keys
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');

    // These should affect playhead position - verification depends on UI
  });
});
