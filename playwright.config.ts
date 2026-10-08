import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results/e2e',
  timeout: 90000,
  expect: { timeout: 15000 },
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:3000', trace: 'retain-on-failure' },
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: {
    command: 'pnpm start',
    url: 'http://127.0.0.1:3000/api/status',
    timeout: 60000,
    reuseExistingServer: process.env.PRODUCTSPY_E2E_EXTERNAL_SERVER === '1',
    env: {
      AI_MODE: 'mock',
      PRODUCTSPY_DATA_DIR: resolve('.test-data'),
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
