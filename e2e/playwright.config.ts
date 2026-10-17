import { defineConfig, devices } from '@playwright/test';

/**
 * Browser suite. A real Alibi server (from the target clone, sandbox disabled,
 * providers mocked) is started by global-setup.ts and seeded with real offline
 * investigations. Rich states are served with page.route() from synthetic
 * bundles. No provider is ever called.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: '../test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json']],
  globalSetup: './global-setup.ts',
  use: { trace: 'retain-on-failure', screenshot: 'off', video: 'off' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } },
    { name: 'tablet', testMatch: /navigation\.spec\.ts$/, use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 }, hasTouch: true } },
    { name: 'mobile', testMatch: /navigation\.spec\.ts$/, use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  ],
});
