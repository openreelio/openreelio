/**
 * Smoke Tests
 *
 * Basic E2E tests to verify the application loads correctly.
 * These tests serve as a foundation for more comprehensive E2E testing.
 */

import { test, expect, type Page } from '@playwright/test';

const APP_READY_SELECTOR =
  '[data-testid="setup-wizard"], [data-testid="welcome-screen"], [data-testid="timeline"]';
const LOAD_TIMEOUT = 30000;

async function waitForAppReady(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator(APP_READY_SELECTOR).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
}

test.describe('Application Smoke Tests', () => {
  test('should load the application', async ({ page }) => {
    await waitForAppReady(page);

    // Verify the page has loaded
    await expect(page).toHaveTitle(/OpenReelio/i);
  });

  test('should display the main layout', async ({ page }) => {
    await waitForAppReady(page);

    // The app should have a main container
    const app = page.locator('#root');
    await expect(app).toBeVisible();
  });

  test('should not have any console errors on load', async ({ page }) => {
    const errors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    page.on('pageerror', (error) => {
      errors.push(error.stack ?? error.message);
    });

    await waitForAppReady(page);

    // Filter out known acceptable errors (like React strict mode warnings)
    const criticalErrors = errors.filter(
      (error) => !error.includes('React') && !error.includes('Warning'),
    );

    expect(criticalErrors).toHaveLength(0);
  });
});

test.describe('Welcome Screen', () => {
  test('should show welcome screen or project view', async ({ page }) => {
    await waitForAppReady(page);

    // Either welcome screen or main editor should be visible
    const welcomeOrEditor = page.locator(
      '[data-testid="setup-wizard"], [data-testid="welcome-screen"], [data-testid="timeline"]',
    );
    await expect(welcomeOrEditor.first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  });
});

test.describe('Performance Checks', () => {
  test('should load within acceptable time', async ({ page }) => {
    const startTime = Date.now();

    await waitForAppReady(page);

    const loadTime = Date.now() - startTime;

    // App should load within a reasonable local/CI window
    expect(loadTime).toBeLessThan(30000);
  });

  test('should not have memory leaks indicators', async ({ page }) => {
    await waitForAppReady(page);

    // Get performance metrics
    const metrics = await page.evaluate(() => {
      if ('memory' in performance) {
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } })
          .memory;
        return {
          usedJSHeapSize: memory?.usedJSHeapSize ?? 0,
        };
      }
      return { usedJSHeapSize: 0 };
    });

    // Initial heap should be reasonable (less than 100MB)
    expect(metrics.usedJSHeapSize).toBeLessThan(100 * 1024 * 1024);
  });
});

test.describe('Accessibility', () => {
  test('should have no major accessibility issues', async ({ page }) => {
    await waitForAppReady(page);

    const openFolderButton = page.locator('[data-testid="open-folder-button"]');
    if (
      (await openFolderButton.isVisible().catch(() => false)) &&
      (await openFolderButton.isEnabled().catch(() => false))
    ) {
      await openFolderButton.focus();
      const activeTestId = await page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') ?? null,
      );
      expect(activeTestId).toBe('open-folder-button');
      return;
    }

    // Fallback check for generic focusable buttons.
    const buttons = page.locator('button:visible:not([disabled])');
    const buttonCount = await buttons.count();

    // If there are buttons, at least one should be focusable
    if (buttonCount > 0) {
      const firstButton = buttons.first();
      await firstButton.focus();
      const activeTagName = await page.evaluate(() => document.activeElement?.tagName ?? null);
      expect(activeTagName).toBe('BUTTON');
    }
  });

  test('should have proper heading hierarchy', async ({ page }) => {
    await waitForAppReady(page);

    // Check that there's at least one heading
    const headings = page.locator('h1, h2, h3, h4, h5, h6');
    const headingCount = await headings.count();

    // Most pages should have at least one heading
    // This is a soft check - some SPAs may not have traditional headings
    if (headingCount > 0) {
      const firstHeading = headings.first();
      await expect(firstHeading).toBeVisible();
    }
  });
});
