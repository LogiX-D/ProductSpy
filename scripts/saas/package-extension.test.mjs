import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { workspace } from '../packaging/files.mjs';
import { assertLegacyPackaging } from './package-extension-legacy-guard.mjs';
import {
  assertPublicBytes,
  packageTarget,
  sha256,
  validateCompiledExtension,
  writeExtensionBuildMetadata,
} from './package-extension-validation.mjs';
import { verifySaasArchive } from './package-extension.mjs';
import { createRequire } from 'node:module';
import {
  PRODUCTSPY_EXTENSION_PUBLIC_KEY,
  PRODUCTSPY_EXTENSION_ID,
} from '../../packages/shared/src/extension-identity.ts';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const JSZip = createRequire(resolve(workspace, 'apps/web/package.json'))('jszip');
const development = { mode: 'saas', environment: 'development', origin: 'http://127.0.0.1:3000' };
async function fixture(run, target = development) {
  const root = await mkdtemp(resolve(tmpdir(), 'productspy-extension-package-'));
  try {
    const manifest = {
      manifest_version: 3,
      key: PRODUCTSPY_EXTENSION_PUBLIC_KEY,
      name: 'ProductSpy',
      version: '1.0.0.3',
      version_name: '1.0.0',
      permissions: ['activeTab', 'scripting', 'storage', 'alarms'],
      host_permissions: [`${target.origin}/*`],
      background: { service_worker: 'background.js', type: 'module' },
      action: { default_popup: 'popup.html' },
      content_security_policy: { extension_pages: "script-src 'self'; object-src 'self';" },
    };
    await mkdir(resolve(root, 'assets'));
    for (const [name, content] of Object.entries({
      'manifest.json': JSON.stringify(manifest),
      'background.js': 'console.log("synthetic fixture");',
      'content.js': 'console.log("content fixture");',
      'popup.html': '<html>synthetic fixture</html>',
      'assets/popup.js': 'console.log("popup");',
    }))
      await writeFile(resolve(root, name), content);
    await writeExtensionBuildMetadata(root, target, workspace);
    await run(root, manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('SaaS extension package trust boundaries', () => {
  it('pins the public preview identity and refuses a changed key', async () => {
    const id = createHash('sha256')
      .update(Buffer.from(PRODUCTSPY_EXTENSION_PUBLIC_KEY, 'base64'))
      .digest('hex')
      .slice(0, 32)
      .replace(/[0-9a-f]/g, (value) => String.fromCharCode(97 + Number.parseInt(value, 16)));
    expect(id).toBe(PRODUCTSPY_EXTENSION_ID);
    await fixture(async (root, manifest) => {
      manifest.key = 'untrusted-key';
      await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest));
      await writeExtensionBuildMetadata(root, development, workspace);
      await expect(validateCompiledExtension(root, development, '1.0.0', {})).rejects.toThrow(
        'identity',
      );
    });
  });
  it('requires explicit exact deployment settings and rejects production loopback or legacy', () => {
    for (const target of [
      {},
      { ...development, environment: 'prod' },
      { ...development, mode: 'legacy' },
      { ...development, environment: 'production' },
      { ...development, environment: 'production', origin: 'https://localhost.' },
      { ...development, environment: 'production', origin: 'https://127.0.0.2' },
      { ...development, origin: 'https://user:synthetic-password@app.example.invalid' },
    ])
      expect(() => packageTarget(target)).toThrow();
    expect(
      packageTarget({
        ...development,
        environment: 'production',
        origin: 'https://preview.example.invalid',
      }).origin,
    ).toBe('https://preview.example.invalid');
  });

  it('checks the actual compiled inventory and refuses stale endpoint/environment metadata', async () => {
    await fixture(async (root) => {
      expect(
        (await validateCompiledExtension(root, development, '1.0.0', {})).manifest.host_permissions,
      ).toEqual(['http://127.0.0.1:3000/*']);
      await expect(
        validateCompiledExtension(
          root,
          { ...development, origin: 'https://preview.example.invalid', environment: 'production' },
          '1.0.0',
          {},
        ),
      ).rejects.toThrow('metadata');
      await writeFile(resolve(root, 'background.js'), 'console.log("modified after build");');
      await expect(validateCompiledExtension(root, development, '1.0.0', {})).rejects.toThrow(
        'checksums',
      );
    });
  });

  it('rejects a manifest origin or permission change even after rebuilding its inventory', async () => {
    await fixture(async (root, manifest) => {
      manifest.host_permissions = ['https://different.example.invalid/*'];
      await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest));
      await writeExtensionBuildMetadata(root, development, workspace);
      await expect(validateCompiledExtension(root, development, '1.0.0', {})).rejects.toThrow(
        'Manifest origin',
      );
      manifest.host_permissions = [`${development.origin}/*`];
      manifest.permissions.push('tabs');
      await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest));
      await writeExtensionBuildMetadata(root, development, workspace);
      await expect(validateCompiledExtension(root, development, '1.0.0', {})).rejects.toThrow(
        'permissions',
      );
    });
  });

  it('rejects absent metadata, extra files and source maps', async () => {
    await fixture(async (root) => {
      await writeFile(resolve(root, 'extra.txt'), 'unexpected');
      await expect(validateCompiledExtension(root, development, '1.0.0', {})).rejects.toThrow(
        'inventory',
      );
      await rm(resolve(root, 'extra.txt'));
      await writeFile(resolve(root, 'background.js.map'), '{}');
      await expect(validateCompiledExtension(root, development, '1.0.0', {})).rejects.toThrow(
        'source map',
      );
      await rm(resolve(root, 'productspy-build.json'));
      await expect(validateCompiledExtension(root, development, '1.0.0', {})).rejects.toThrow();
    });
  });

  it('rejects added optional permissions, automatic injection, remote updates and weakened CSP', async () => {
    await fixture(async (root, manifest) => {
      for (const field of [
        'optional_permissions',
        'optional_host_permissions',
        'content_scripts',
        'externally_connectable',
        'web_accessible_resources',
        'update_url',
        'oauth2',
      ]) {
        const modified = {
          ...manifest,
          [field]:
            field === 'update_url'
              ? 'https://remote.example.invalid/update.xml'
              : ['synthetic-extra-capability'],
        };
        await writeFile(resolve(root, 'manifest.json'), JSON.stringify(modified));
        await writeExtensionBuildMetadata(root, development, workspace);
        await expect(validateCompiledExtension(root, development, '1.0.0', {})).rejects.toThrow(
          'manifest capability',
        );
      }
      manifest.content_security_policy.extension_pages =
        "script-src 'self' 'unsafe-eval'; object-src 'self';";
      await writeFile(resolve(root, 'manifest.json'), JSON.stringify(manifest));
      await writeExtensionBuildMetadata(root, development, workspace);
      await expect(validateCompiledExtension(root, development, '1.0.0', {})).rejects.toThrow(
        'Content Security Policy',
      );
    });
  });

  it('detects configured server secrets and payment/database patterns without echoing values', () => {
    const configured = `synthetic-configured-secret-${'z'.repeat(32)}`;
    for (const name of [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'DATABASE_URL',
      'PRODUCTSPY_ARCHIVE_SECRET',
      'AI_API_KEY',
    ]) {
      let message = '';
      try {
        assertPublicBytes(Buffer.from(configured), { [name]: configured });
      } catch (error) {
        message = error.message;
      }
      expect(message).toContain('configured server secret');
      expect(message).not.toContain(configured);
    }
    for (const value of [
      `sk_test_${'A'.repeat(24)}`,
      `sk_live_${'B'.repeat(24)}`,
      `whsec_${'C'.repeat(24)}`,
      'postgresql://app:synthetic-password@db:5432/productspy',
    ]) {
      let message = '';
      try {
        assertPublicBytes(Buffer.from(value), {});
      } catch (error) {
        message = error.message;
      }
      expect(message).toMatch(/payment secret|database connection/);
      expect(message).not.toContain(value);
    }
  });

  it('scans real files before accepting a correctly hashed build that contains a secret', async () => {
    await fixture(async (root) => {
      const value = `synthetic-private-archive-${'Q'.repeat(32)}`;
      await writeFile(
        resolve(root, 'assets/popup.js'),
        `const configured = ${JSON.stringify(value)};`,
      );
      await writeExtensionBuildMetadata(root, development, workspace);
      const error = await validateCompiledExtension(root, development, '1.0.0', {
        PRODUCTSPY_ARCHIVE_SECRET: value,
      }).then(
        () => null,
        (error) => error,
      );
      expect(error.message).toContain('configured server secret (PRODUCTSPY_ARCHIVE_SECRET)');
      expect(error.message).not.toContain(value);
    });
  });

  it('verifies real ZIP payload bytes and root paths instead of trusting a receipt', async () => {
    await fixture(async (root) => {
      const bytes = Buffer.from('synthetic manifest bytes');
      const zip = new JSZip();
      zip.file('manifest.json', bytes, { createFolders: false });
      zip.file('productspy-build.json', '{}', { createFolders: false });
      const path = resolve(root, 'test.zip');
      await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
      const files = [
        { path: 'manifest.json', bytes: bytes.length, sha256: sha256(bytes) },
        { path: 'productspy-build.json', bytes: 2, sha256: sha256(Buffer.from('{}')) },
      ];
      await expect(verifySaasArchive(path, files)).resolves.toBeUndefined();
      await expect(
        verifySaasArchive(
          path,
          files.map((row) => ({ ...row, sha256: '0'.repeat(64) })),
        ),
      ).rejects.toThrow('checksum');
    });
  });

  it('requires all legacy modes explicitly and stops historical entry points before artifact mutation', async () => {
    expect(() => assertLegacyPackaging({ PRODUCTSPY_MODE: 'legacy' })).toThrow(
      'Historical packaging',
    );
    expect(() =>
      assertLegacyPackaging({
        PRODUCTSPY_MODE: 'legacy',
        NEXT_PUBLIC_PRODUCTSPY_MODE: 'legacy',
        VITE_PRODUCTSPY_MODE: 'legacy',
      }),
    ).not.toThrow();
    const frozen = [
      'extension-manifest.json',
      'release-manifest.json',
      'ProductSpy-1.0.0-extension.zip',
    ];
    const before = await Promise.all(
      frozen.map(async (name) =>
        readFile(resolve(workspace, 'artifacts', name)).then(sha256, () => null),
      ),
    );
    for (const script of ['package-extension.mjs', 'package-store.mjs', 'package-windows.mjs']) {
      const error = await execute(process.execPath, [resolve(workspace, 'scripts', script)], {
        cwd: workspace,
        windowsHide: true,
        env: {
          ...process.env,
          PRODUCTSPY_MODE: 'saas',
          NEXT_PUBLIC_PRODUCTSPY_MODE: 'saas',
          VITE_PRODUCTSPY_MODE: 'saas',
        },
      }).then(
        () => null,
        (error) => error,
      );
      expect(error?.code).toBe(1);
      expect(error.stderr).toContain('Historical packaging is disabled for SaaS');
    }
    expect(
      await Promise.all(
        frozen.map(async (name) =>
          readFile(resolve(workspace, 'artifacts', name)).then(sha256, () => null),
        ),
      ),
    ).toEqual(before);
  });

  it('supports read-only CLI help and refuses missing/unknown arguments', async () => {
    const script = resolve(workspace, 'scripts/saas/package-extension.mjs');
    expect(
      (await execute(process.execPath, [script, '--help'], { windowsHide: true })).stdout,
    ).toContain('Local preview only');
    for (const args of [[], ['--environment', 'prod'], ['--unknown', 'synthetic-never-print']]) {
      const error = await execute(process.execPath, [script, ...args], { windowsHide: true }).then(
        () => null,
        (error) => error,
      );
      expect(error?.code).toBe(1);
      expect(error.stderr).not.toContain('synthetic-never-print');
    }
  });
});
