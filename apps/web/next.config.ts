import type { NextConfig } from 'next';
import { resolve } from 'node:path';
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
  outputFileTracingExcludes: {
    '/*': [
      '.env*',
      '.data/**/*',
      '../../.test-data/**/*',
      '../../.pack-cache/**/*',
      '../../artifacts/**/*',
      '../../.git/**/*',
      '../../docs/**/*',
      '../../e2e/**/*',
      '**/*.test.ts',
      '../../packages/**/*.test.ts',
      '../../scripts/**/*',
      '../../apps/extension/tests/**/*',
    ],
  },
  transpilePackages: ['@productspy/shared'],
  poweredByHeader: false,
  devIndicators: false,
  headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};
export default config;
