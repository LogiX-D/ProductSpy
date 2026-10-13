import { configDefaults, defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'scripts/**/*.test.mjs'],
    exclude: [...configDefaults.exclude, '**/.next/**', '**/dist/**', '**/artifacts/**'],
    environment: 'node',
    restoreMocks: true,
  },
});
