import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build, defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { extensionConfig } from './src/deployment-config';

const directory = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, directory, ''), ...process.env };
  const target = extensionConfig(
    env.VITE_PRODUCTSPY_APP_URL,
    env.VITE_PRODUCTSPY_MODE,
    env.VITE_PRODUCTSPY_ENV,
  );
  let outputDirectory = resolve(directory, 'dist');
  return {
    define: {
      'import.meta.env.VITE_PRODUCTSPY_APP_URL': JSON.stringify(target.appUrl),
      'import.meta.env.VITE_PRODUCTSPY_MODE': JSON.stringify(target.legacy ? 'legacy' : 'saas'),
      'import.meta.env.VITE_PRODUCTSPY_ENV': JSON.stringify(
        env.VITE_PRODUCTSPY_ENV ?? 'development',
      ),
    },
    plugins: [
      react(),
      {
        name: 'productspy-content-and-manifest',
        configResolved(config) {
          outputDirectory = resolve(config.root, config.build.outDir);
        },
        async closeBundle() {
          await build({
            configFile: false,
            root: directory,
            build: {
              outDir: outputDirectory,
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
          const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
          manifest.host_permissions = target.legacy
            ? ['http://localhost/*', 'http://127.0.0.1/*']
            : [`${target.appUrl}/*`];
          manifest.permissions = target.legacy
            ? ['activeTab', 'scripting', 'storage']
            : ['activeTab', 'scripting', 'storage', 'alarms'];
          manifest.description = target.legacy
            ? '采集 Amazon 商品素材，保存到本地 ProductSpy 工作台。'
            : '采集 Amazon 商品资料，安全同步至 ProductSpy 在线 SaaS 工作台。';
          await writeFile(
            resolve(outputDirectory, 'manifest.json'),
            JSON.stringify(manifest, null, 2),
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
  };
});
