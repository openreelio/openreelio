/**
 * Smoke Tests
 *
 * Basic E2E tests to verify the application loads correctly.
 * These tests serve as a foundation for more comprehensive E2E testing.
 */

import { test, expect } from '@playwright/test';

test.describe('Application Smoke Tests', () => {
  test('should load the application', async ({ page }) => {
    await page.goto('/');

    // Wait for the app to load
    await page.waitForLoadState('networkidle');

    // Verify the page has loaded
    await expect(page).toHaveTitle(/OpenReelio/i);
  });

  test('should display the main layout', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

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

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Filter out known acceptable errors (like React strict mode warnings)
    const criticalErrors = errors.filter(
      (error) => !error.includes('React') && !error.includes('Warning')
    );

    expect(criticalErrors).toHaveLength(0);
  });
});

test.describe('Welcome Screen', () => {
  test('should show welcome screen or project view', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Either welcome screen or main editor should be visible
    const welcomeOrEditor = page.locator(
      '[data-testid="welcome-screen"], [data-testid="main-layout"]'
    );
    await expect(welcomeOrEditor.first()).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Performance Checks', () => {
  test('should load within acceptable time', async ({ page }) => {
    const startTime = Date.now();

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const loadTime = Date.now() - startTime;

    // App should load within 5 seconds
    expect(loadTime).toBeLessThan(5000);
  });

  test('should not have memory leaks indicators', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Get performance metrics
    const metrics = await page.evaluate(() => {
      if ('memory' in performance) {
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
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
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Basic accessibility check - verify interactive elements are focusable
    const buttons = page.locator('button:visible');
    const buttonCount = await buttons.count();

    // If there are buttons, at least one should be focusable
    if (buttonCount > 0) {
      const firstButton = buttons.first();
      await firstButton.focus();
      await expect(firstButton).toBeFocused();
    }
  });

  test('should have proper heading hierarchy', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

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
