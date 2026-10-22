import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
export default defineConfig({
  testDir: './e2e/saas',
  outputDir: 'test-results/saas',
  timeout: 90000,
  workers: 1,
  expect: { timeout: 15000 },
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure', actionTimeout: 15000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report/saas', open: 'never' }],
    ['json', { outputFile: '.test-data/saas/e2e-report.json' }],
  ],
  webServer: {
    command: 'pnpm exec tsx scripts/saas/start-browser-test.ts',
    url: 'http://127.0.0.1:3100/api/health',
    timeout: 90000,
    reuseExistingServer: false,
    env: {
      PORT: '3100',
      PRODUCTSPY_MODE: 'saas',
      NEXT_PUBLIC_PRODUCTSPY_MODE: 'saas',
      PRODUCTSPY_ENV: 'test',
      PRODUCTSPY_APP_URL: 'http://127.0.0.1:3100',
      PRODUCTSPY_DB_DRIVER: 'pglite',
      PRODUCTSPY_ALLOW_PGLITE: '1',
      PRODUCTSPY_PGLITE_DIR: resolve('.test-data/saas', `db-${Date.now()}`),
      PRODUCTSPY_ARCHIVE_SECRET: 'synthetic-e2e-archive-secret-not-for-production',
      AI_MODE: 'auto',
      AI_API_KEY: '',
      PRODUCTSPY_AI_ADMIN_IDS: '00000000-0000-4000-8000-000000000001',
      PRODUCTSPY_AI_CHANNEL_SECRET: 'synthetic-browser-channel-master-key-not-for-production',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
