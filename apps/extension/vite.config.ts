import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const directory = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'productspy-content-and-manifest',
      async closeBundle() {
        await build({
          configFile: false,
          root: directory,
          build: {
            outDir: resolve(directory, 'dist'),
            emptyOutDir: false,
            lib: {
              entry: resolve(directory, 'src/content/index.ts'),
              name: 'ProductSpyContent',
              formats: ['iife'],
              fileName: () => 'content.js',
            },
            rollupOptions: { output: { inlineDynamicImports: true } },
          },
        });
        await copyFile(
          resolve(directory, 'manifest.json'),
          resolve(directory, 'dist/manifest.json'),
        );
      },
    },
  ],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        popup: resolve(directory, 'popup.html'),
        background: resolve(directory, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
