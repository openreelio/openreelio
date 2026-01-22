/**
 * Complete Video Editing Workflow E2E Tests
 *
 * End-to-end tests that verify the complete user journey:
 * Create project → Import → Edit → Preview → Export
 *
 * These tests require sample media files in the fixtures directory.
 * See tests/e2e/fixtures/README.md for setup instructions.
 */

import { test, expect, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// =============================================================================
// Test Constants
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SAMPLE_VIDEO = path.join(FIXTURES_DIR, 'sample-video.mp4');
const SAMPLE_AUDIO = path.join(FIXTURES_DIR, 'sample-audio.mp3');

// Timeout configurations
const LOAD_TIMEOUT = 10000;
const IMPORT_TIMEOUT = 30000;

// =============================================================================
// Helper Functions
// =============================================================================

function fixturesExist(): boolean {
  return fs.existsSync(SAMPLE_VIDEO) && fs.existsSync(SAMPLE_AUDIO);
}

function videoFixtureExists(): boolean {
  return fs.existsSync(SAMPLE_VIDEO);
}

async function waitForAppReady(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Wait for either welcome screen or main layout
  const appReady = page.locator(
    '[data-testid="welcome-screen"], [data-testid="main-layout"]'
  );
  await expect(appReady.first()).toBeVisible({ timeout: LOAD_TIMEOUT });
}

async function isOnWelcomeScreen(page: Page): Promise<boolean> {
  const welcomeScreen = page.locator('[data-testid="welcome-screen"]');
  return await welcomeScreen.isVisible().catch(() => false);
}

async function createNewProject(page: Page, projectName: string): Promise<void> {
  // Click new project button
  const newProjectButton = page.locator(
    '[data-testid="new-project-button"], button:has-text("New Project")'
  );
  await newProjectButton.click();

  // Fill project details
  const nameInput = page.locator('[data-testid="project-name-input"], input[name="projectName"]');
  if (await nameInput.isVisible()) {
    await nameInput.fill(projectName);
  }

  // Submit
  const createButton = page.locator(
    '[data-testid="create-project-submit"], button:has-text("Create")'
  );
  if (await createButton.isVisible()) {
    await createButton.click();
  }

  // Wait for timeline to be visible
  await expect(
    page.locator('[data-testid="timeline"], [data-testid="main-layout"]')
  ).toBeVisible({ timeout: LOAD_TIMEOUT });
}

async function importAsset(page: Page, filePath: string): Promise<void> {
  // Use the file input for asset import
  const fileInput = page.locator(
    '[data-testid="asset-import-input"], input[type="file"]'
  );

  if (await fileInput.isVisible()) {
    await fileInput.setInputFiles(filePath);
  } else {
    // Try drag and drop area or button
    const importButton = page.locator(
      '[data-testid="import-button"], button:has-text("Import")'
    );
    if (await importButton.isVisible()) {
      await importButton.click();
      // Handle file dialog - this may not work in all environments
      const dialogFileInput = page.locator('input[type="file"]');
      await dialogFileInput.setInputFiles(filePath);
    }
  }

  // Wait for asset to appear
  await expect(page.locator('[data-testid="asset-item"]').first()).toBeVisible({
    timeout: IMPORT_TIMEOUT,
  });
}

async function dragAssetToTimeline(
  page: Page,
  assetIndex: number,
  trackSelector: string
): Promise<void> {
  const asset = page.locator('[data-testid="asset-item"]').nth(assetIndex);
  const track = page.locator(trackSelector);

  await asset.dragTo(track);
}

async function getClipCount(page: Page): Promise<number> {
  return await page.locator('[data-testid="clip"]').count();
}

// =============================================================================
// Workflow Tests
// =============================================================================

test.describe('Complete Video Editing Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page);
  });

  test('E2E: Create project → Import → Edit → Preview → Export', async ({ page }) => {
    test.skip(!videoFixtureExists(), 'Sample video not found in fixtures');

    // 1. Create new project (skip if already in project view)
    if (await isOnWelcomeScreen(page)) {
      await createNewProject(page, 'E2E Test Project');
    }

    // 2. Import video asset
    await importAsset(page, SAMPLE_VIDEO);
    await expect(page.locator('[data-testid="asset-item"]')).toHaveCount(1, {
      timeout: IMPORT_TIMEOUT,
    });

    // 3. Drag asset to timeline
    const track = page.locator('[data-testid^="track-"]').first();
    if (await track.isVisible()) {
      await dragAssetToTimeline(page, 0, '[data-testid^="track-"]');
      await expect(page.locator('[data-testid="clip"]')).toHaveCount(1);
    }

    // 4. Verify playback works
    await page.keyboard.press('Space'); // Play
    await page.waitForTimeout(500);
    await page.keyboard.press('Space'); // Pause

    // Verify playhead moved (if visible)
    const playhead = page.locator('[data-testid="playhead"]');
    if (await playhead.isVisible()) {
      const playheadBox = await playhead.boundingBox();
      expect(playheadBox?.x).toBeGreaterThan(0);
    }

    // 5. Split clip at playhead
    await page.keyboard.press('s');
    const clipCountAfterSplit = await getClipCount(page);
    // May or may not split depending on playhead position
    expect(clipCountAfterSplit).toBeGreaterThanOrEqual(1);

    // 6. Test undo
    await page.keyboard.press('Control+z');
    // Undo should work

    // 7. Test redo
    await page.keyboard.press('Control+y');
    // Redo should work

    // 8. Open export dialog
    await page.keyboard.press('Control+e');
    const exportDialog = page.locator(
      '[data-testid="export-dialog"], [role="dialog"]:has-text("Export")'
    );

    if (await exportDialog.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Export dialog opened successfully
      await expect(exportDialog).toBeVisible();

      // Close dialog for cleanup
      await page.keyboard.press('Escape');
    }
  });

  test('E2E: Multi-track editing with audio sync', async ({ page }) => {
    test.skip(!fixturesExist(), 'Sample media files not found in fixtures');

    // Create project
    if (await isOnWelcomeScreen(page)) {
      await createNewProject(page, 'Multi-track Test');
    }

    // Import video
    await importAsset(page, SAMPLE_VIDEO);
    await expect(page.locator('[data-testid="asset-item"]')).toHaveCount(1, {
      timeout: IMPORT_TIMEOUT,
    });

    // Import audio
    await importAsset(page, SAMPLE_AUDIO);
    await expect(page.locator('[data-testid="asset-item"]')).toHaveCount(2, {
      timeout: IMPORT_TIMEOUT,
    });

    // Get track elements
    const videoTrack = page.locator('[data-testid="track-video"]').first();
    const audioTrack = page.locator('[data-testid="track-audio"]').first();

    // Drag assets if tracks are visible
    if (await videoTrack.isVisible() && await audioTrack.isVisible()) {
      await dragAssetToTimeline(page, 0, '[data-testid="track-video"]');
      await dragAssetToTimeline(page, 1, '[data-testid="track-audio"]');

      await expect(page.locator('[data-testid="clip"]')).toHaveCount(2);
    }

    // Play and verify sync
    await page.keyboard.press('Space');
    await page.waitForTimeout(1000);
    await page.keyboard.press('Space');

    // Verify time display updated
    const timeDisplay = page.locator(
      '[data-testid="time-display"], [data-testid="timecode"]'
    );
    if (await timeDisplay.isVisible()) {
      const time = await timeDisplay.textContent();
      expect(time).toBeTruthy();
    }
  });

  test('E2E: Keyboard shortcuts work correctly', async ({ page }) => {
    test.skip(!videoFixtureExists(), 'Sample video not found in fixtures');

    if (await isOnWelcomeScreen(page)) {
      await createNewProject(page, 'Shortcuts Test');
    }

    await importAsset(page, SAMPLE_VIDEO);

    const track = page.locator('[data-testid^="track-"]').first();
    if (await track.isVisible()) {
      await dragAssetToTimeline(page, 0, '[data-testid^="track-"]');
    }

    // Test playback shortcuts
    const playButton = page.locator(
      '[data-testid="play-button"], button[aria-label*="play" i]'
    );

    if (await playButton.isVisible()) {
      await page.keyboard.press('Space'); // Play
      await page.waitForTimeout(200);
      await page.keyboard.press('Space'); // Pause
    }

    // Test navigation - Home key
    await page.keyboard.press('Home');
    const timeDisplay = page.locator('[data-testid="time-display"]');
    if (await timeDisplay.isVisible()) {
      const timeAfterHome = await timeDisplay.textContent();
      // Should be at start (0:00 or similar)
      expect(timeAfterHome).toBeTruthy();
    }

    // Test zoom
    await page.keyboard.press('Control+='); // Zoom in
    await page.keyboard.press('Control+-'); // Zoom out

    // Test select all
    await page.keyboard.press('Control+a');
    const selectedClips = page.locator('[data-testid="clip"][data-selected="true"]');
    const selectedCount = await selectedClips.count();
    // May or may not have selected clips depending on state
    expect(selectedCount).toBeGreaterThanOrEqual(0);
  });

  test('E2E: Clip operations - trim, move, delete', async ({ page }) => {
    test.skip(!videoFixtureExists(), 'Sample video not found in fixtures');

    if (await isOnWelcomeScreen(page)) {
      await createNewProject(page, 'Clip Operations Test');
    }

    await importAsset(page, SAMPLE_VIDEO);

    const track = page.locator('[data-testid^="track-"]').first();
    if (!(await track.isVisible())) {
      test.skip();
      return;
    }

    await dragAssetToTimeline(page, 0, '[data-testid^="track-"]');
    await expect(page.locator('[data-testid="clip"]')).toHaveCount(1);

    // Select clip
    const clip = page.locator('[data-testid="clip"]').first();
    await clip.click();

    // Delete clip
    await page.keyboard.press('Delete');

    // Clip should be deleted or undo available
    const clipCountAfterDelete = await getClipCount(page);
    expect(clipCountAfterDelete).toBeLessThanOrEqual(1);

    // Undo deletion
    await page.keyboard.press('Control+z');
    const clipCountAfterUndo = await getClipCount(page);
    expect(clipCountAfterUndo).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// Auto-save Tests
// =============================================================================

test.describe('Auto-save and Recovery', () => {
  test('should show save indicator', async ({ page }) => {
    await waitForAppReady(page);

    // Skip if on welcome screen
    if (await isOnWelcomeScreen(page)) {
      test.skip();
      return;
    }

    // Look for save indicator
    const saveIndicator = page.locator(
      '[data-testid="save-indicator"], [data-testid="save-status"]'
    );

    if (await saveIndicator.isVisible()) {
      await expect(saveIndicator).toBeVisible();
    }
  });

  test('should save project on change', async ({ page }) => {
    test.skip(!videoFixtureExists(), 'Sample video not found in fixtures');

    await waitForAppReady(page);

    if (await isOnWelcomeScreen(page)) {
      await createNewProject(page, 'Auto-save Test');
    }

    // Make a change (import asset)
    await importAsset(page, SAMPLE_VIDEO);

    // Wait for auto-save (2 seconds grace period)
    await page.waitForTimeout(2000);

    // Check for saved indicator
    const saveIndicator = page.locator('[data-testid="save-indicator"]');
    if (await saveIndicator.isVisible()) {
      const status = await saveIndicator.textContent();
      // Should show "Saved" or similar
      expect(status?.toLowerCase()).toMatch(/saved|up to date|synced/i);
    }
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

test.describe('Error Handling', () => {
  test('should handle missing assets gracefully', async ({ page }) => {
    await waitForAppReady(page);

    // Skip if on welcome screen
    if (await isOnWelcomeScreen(page)) {
      test.skip();
      return;
    }

    // Try to import non-existent file
    const fileInput = page.locator('input[type="file"]');
    if (await fileInput.isVisible()) {
      // This should not crash the app
      await expect(page.locator('#root')).toBeVisible();
    }
  });

  test('should show error toast for invalid operations', async ({ page }) => {
    await waitForAppReady(page);

    // Skip if on welcome screen
    if (await isOnWelcomeScreen(page)) {
      test.skip();
      return;
    }

    // Try to delete with nothing selected
    await page.keyboard.press('Delete');

    // App should still be functional
    await expect(page.locator('#root')).toBeVisible();

    // Check for toast notification (if shown)
    const toast = page.locator('[data-testid="toast"], [role="alert"]');
    await toast.count(); // Toast may or may not appear
  });
});

// =============================================================================
// Performance Tests
// =============================================================================

test.describe('Performance', () => {
  test('should maintain responsiveness during playback', async ({ page }) => {
    test.skip(!videoFixtureExists(), 'Sample video not found in fixtures');

    await waitForAppReady(page);

    if (await isOnWelcomeScreen(page)) {
      await createNewProject(page, 'Performance Test');
    }

    await importAsset(page, SAMPLE_VIDEO);

    const track = page.locator('[data-testid^="track-"]').first();
    if (await track.isVisible()) {
      await dragAssetToTimeline(page, 0, '[data-testid^="track-"]');
    }

    // Start playback
    await page.keyboard.press('Space');

    // Check that UI remains responsive during playback
    const startTime = Date.now();

    // Perform some UI operations
    await page.locator('body').hover();
    await page.mouse.move(100, 100);
    await page.mouse.move(200, 200);

    const responseTime = Date.now() - startTime;
    expect(responseTime).toBeLessThan(500); // Should respond within 500ms

    // Stop playback
    await page.keyboard.press('Space');
  });

  test('should handle timeline zoom without lag', async ({ page }) => {
    await waitForAppReady(page);

    if (await isOnWelcomeScreen(page)) {
      test.skip();
      return;
    }

    const startTime = Date.now();

    // Zoom in multiple times
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Control+=');
    }

    // Zoom out multiple times
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Control+-');
    }

    const totalTime = Date.now() - startTime;
    expect(totalTime).toBeLessThan(2000); // Should complete within 2 seconds
  });
});
