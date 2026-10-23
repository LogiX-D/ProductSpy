import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../../apps/extension/node_modules/vite/dist/node/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
process.chdir(resolve(root, 'apps/extension'));
process.env.VITE_PRODUCTSPY_APP_URL = 'http://127.0.0.1:3100';
process.env.VITE_PRODUCTSPY_MODE = 'saas';
process.env.VITE_PRODUCTSPY_ENV = 'test';
await build({
  root: resolve(root, 'apps/extension'),
  configFile: resolve(root, 'apps/extension/vite.config.ts'),
  build: { outDir: resolve(root, 'apps/extension/dist-saas-e2e') },
});
console.log(
  'Built a local test-only MV3 extension for http://127.0.0.1:3100. No production deployment or publishing.',
);
