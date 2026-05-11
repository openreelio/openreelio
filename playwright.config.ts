/**
 * Playwright E2E Test Configuration
 *
 * Configuration for end-to-end tests with Playwright.
 * Tests run against the Vite dev server to validate the Web UI.
 */

import { defineConfig, devices } from '@playwright/test';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import dotenv from 'dotenv';
// dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
const e2eServerMode = process.env.E2E_SERVER_MODE === 'dev' ? 'dev' : 'preview';
const e2eHost = process.env.E2E_HOST ?? '127.0.0.1';
const e2ePort = Number(process.env.E2E_PORT ?? (e2eServerMode === 'preview' ? '4173' : '5173'));
const e2eBaseUrl = process.env.E2E_BASE_URL ?? `http://${e2eHost}:${e2ePort}`;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const e2eWebServerCommand =
  e2eServerMode === 'dev'
    ? `${npmCommand} run dev -- --host ${e2eHost} --port ${e2ePort} --strictPort`
    : `${npmCommand} run build && ${npmCommand} exec -- vite preview --host ${e2eHost} --port ${e2ePort} --strictPort`;

export default defineConfig({
  testDir: './tests/e2e',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [['html', { outputFolder: 'playwright-report' }], ['list']],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: e2eBaseUrl,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',

    /* Take screenshot on failure */
    screenshot: 'only-on-failure',

    /* Record video on failure */
    video: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Note: For Tauri apps, we typically only test in one browser
    // since Tauri uses WebView which is Chromium-based on Windows
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    // Preview is the default because it validates the same bundled graph shipped by Tauri.
    // Set E2E_SERVER_MODE=dev to exercise Vite's dev server explicitly.
    command: e2eWebServerCommand,
    url: e2eBaseUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000, // 2 minutes for initial build
  },

  /* Folder for test artifacts such as screenshots, videos, traces, etc. */
  outputDir: 'test-results/',

  /* Timeout for each test */
  timeout: 60 * 1000, // 60 seconds for initial Vite compile in CI/dev-server mode

  /* Timeout for each expect */
  expect: {
    timeout: 5 * 1000, // 5 seconds
  },
});
