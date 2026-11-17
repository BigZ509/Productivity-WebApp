import { defineConfig, devices } from '@playwright/test'

// E2E runs against the LOCAL Supabase stack only (see docs/TEST_RESULTS.md).
// The dev server uses `--mode e2e`, which reads .env.e2e.local (git-ignored).
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './tests/e2e/global-setup.js',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'app', testIgnore: /pwa\.spec/ },
    { name: 'pwa', testMatch: /pwa\.spec/, use: { baseURL: 'http://localhost:4173' } },
  ],
  webServer: [
    {
      command: 'npx vite --mode e2e --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npx vite build --mode e2e --outDir dist-e2e && npx vite preview --mode e2e --outDir dist-e2e --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
})
