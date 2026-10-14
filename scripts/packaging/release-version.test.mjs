import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { releaseVersion, validateExtensionRelease } from './release-version.mjs';
import { workspace } from './files.mjs';

describe('candidate application and Chrome version mapping', () => {
  it('uses the application RC label for files and the numeric version for Chrome updates', () => {
    expect(releaseVersion('1.0.0-rc.1')).toEqual({
      version: '1.0.0-rc.1',
      extensionVersion: '1.0.0',
      extensionVersionName: '1.0.0-rc.1',
    });
    expect(
      validateExtensionRelease(
        { manifest_version: 3, version: '1.0.0', version_name: '1.0.0-rc.1' },
        '1.0.0-rc.1',
      ).version,
    ).toBe('1.0.0-rc.1');
  });
  it('retains stable release mapping and enforces Chrome numeric constraints', () => {
    expect(releaseVersion('0.8.0')).toEqual({ version: '0.8.0', extensionVersion: '0.8.0' });
    expect(releaseVersion('65535.1.0').extensionVersion).toBe('65535.1.0');
    for (const version of [
      '0.0.0',
      '01.0.0',
      '1.02.0',
      '65536.0.0',
      '1.0.0-rc.0',
      '1.0.0-rc.01',
      '1.0.0-beta.1',
      '../1.0.0',
      '1.0.0/rc.1',
    ])
      expect(() => releaseVersion(version)).toThrow();
  });
  it('refuses mismatched builds and candidates without a clear display label', () => {
    for (const manifest of [
      { manifest_version: 3, version: '1.0.0-rc.1' },
      { manifest_version: 3, version: '1.0.0' },
      { manifest_version: 3, version: '1.0.0', version_name: '1.0.0-rc.2' },
      { manifest_version: 2, version: '1.0.0', version_name: '1.0.0-rc.1' },
    ])
      expect(() => validateExtensionRelease(manifest, '1.0.0-rc.1')).toThrow();
    expect(() =>
      validateExtensionRelease(
        { manifest_version: 3, version: '0.8.0', version_name: 'not-this-release' },
        '0.8.0',
      ),
    ).toThrow();
  });
  it('keeps every workspace package and the distributed manifest on the same release', async () => {
    const project = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'));
    for (const relative of [
      'apps/web/package.json',
      'apps/extension/package.json',
      'packages/shared/package.json',
    ])
      expect(JSON.parse(await readFile(resolve(workspace, relative), 'utf8')).version).toBe(
        project.version,
      );
    const source = JSON.parse(
      await readFile(resolve(workspace, 'apps/extension/manifest.json'), 'utf8'),
    );
    expect(validateExtensionRelease(source, project.version).version).toBe(project.version);
    expect(await readFile(resolve(workspace, 'packages/shared/src/version.ts'), 'utf8')).toContain(
      `PRODUCTSPY_VERSION = '${project.version}'`,
    );
  });
});
