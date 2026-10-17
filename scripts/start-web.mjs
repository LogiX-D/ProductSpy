import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const mode = process.argv[2] ?? 'dev';
const workspace = resolve(import.meta.dirname, '..');
const env = { ...process.env };
if (process.argv.includes('--legacy')) env.PRODUCTSPY_MODE = 'legacy';
env.PRODUCTSPY_MODE ??= 'saas';
env.NEXT_PUBLIC_PRODUCTSPY_MODE = env.PRODUCTSPY_MODE;
if (mode === 'dev' && env.PRODUCTSPY_MODE !== 'legacy') {
  env.PRODUCTSPY_ENV ??= 'development';
  env.PRODUCTSPY_APP_URL ??= `http://127.0.0.1:${env.PORT ?? 3000}`;
  if (!env.DATABASE_URL) {
    env.PRODUCTSPY_DB_DRIVER ??= 'pglite';
    env.PRODUCTSPY_PGLITE_DIR ??= resolve(workspace, '.data/saas-development');
  }
}
const child = spawn(
  process.execPath,
  [
    resolve(workspace, 'apps/web/node_modules/next/dist/bin/next'),
    mode,
    '--hostname',
    env.PRODUCTSPY_BIND_HOST ?? '127.0.0.1',
    '--port',
    env.PORT ?? '3000',
  ],
  { cwd: resolve(workspace, 'apps/web'), env, stdio: 'inherit', windowsHide: true },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
