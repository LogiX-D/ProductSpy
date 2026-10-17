import { configDefaults, defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    env: { PRODUCTSPY_MODE: 'legacy', NEXT_PUBLIC_PRODUCTSPY_MODE: 'legacy' },
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'scripts/**/*.test.mjs'],
    exclude: [...configDefaults.exclude, '**/.next/**', '**/dist/**', '**/artifacts/**'],
    environment: 'node',
    // Bound concurrent forks: full-suite repeated runs otherwise compete with
    // Windows file scanning and can starve report persistence after production builds.
    maxWorkers: 4,
    restoreMocks: true,
  },
});
