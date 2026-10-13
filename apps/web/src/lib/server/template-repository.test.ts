import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builtinTemplates, templateDefinition } from '@productspy/shared';
import { LocalTemplateRepository } from './template-repository';

describe('persistent independent template repository', () => {
  let directory: string;
  let repository: LocalTemplateRepository;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-templates-'));
    repository = new LocalTemplateRepository(directory);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  const definition = () => ({
    ...templateDefinition(builtinTemplates[0]!),
    name: 'Custom template',
  });
  it('lists builtins on fresh startup without writing product or template data', async () => {
    expect(await repository.list()).toEqual(builtinTemplates);
    await expect(readFile(join(directory, 'products.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(repository.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('creates independent copies and reloads all histories after restart', async () => {
    const created = await repository.create(definition());
    expect(created.origin).toBe('custom');
    expect(created.id).not.toBe(builtinTemplates[0]?.id);
    expect(created.versions).toHaveLength(1);
    expect(await new LocalTemplateRepository(directory).get(created.id)).toEqual(created);
    expect(await repository.list()).toHaveLength(5);
  });
  it('serializes independent instances without losing concurrent template creations', async () => {
    const other = new LocalTemplateRepository(directory);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 ? repository : other).create({ ...definition(), name: `Template ${index}` }),
      ),
    );
    expect((await repository.backup()).templates).toHaveLength(8);
  });
  it('preserves edits and restores history by appending a new version', async () => {
    const created = await repository.create(definition());
    const changed = await repository.update(created.id, {
      expectedUpdatedAt: created.updatedAt,
      definition: { ...definition(), prompt: 'Edited {{product_title}}' },
    });
    const restored = await repository.update(created.id, {
      expectedUpdatedAt: changed.updatedAt,
      restoreVersionId: created.versions[0]!.id,
    });
    expect(restored.prompt).toBe(created.prompt);
    expect(restored.versions).toHaveLength(3);
    expect(restored.versions[1]?.snapshot.prompt).toBe('Edited {{product_title}}');
    expect(restored.versions[2]).toMatchObject({
      kind: 'restored',
      restoredFrom: created.versions[0]!.id,
    });
  });
  it('protects simultaneous edits using expectedUpdatedAt and stores favorite changes in history', async () => {
    const created = await repository.create(definition());
    const favorite = await repository.update(created.id, {
      expectedUpdatedAt: created.updatedAt,
      favorite: true,
    });
    await expect(
      repository.update(created.id, {
        expectedUpdatedAt: created.updatedAt,
        definition: { ...definition(), name: 'Lost stale edit' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await repository.get(created.id))?.favorite).toBe(true);
    expect(favorite.versions).toHaveLength(2);
  });
  it('keeps builtins read-only and requires explicit deletion confirmation', async () => {
    const builtin = builtinTemplates[0]!;
    await expect(
      repository.update(builtin.id, { expectedUpdatedAt: builtin.updatedAt, favorite: true }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(repository.delete(builtin.id, builtin.updatedAt, true)).rejects.toMatchObject({
      status: 403,
    });
    const created = await repository.create(definition());
    await expect(repository.delete(created.id, created.updatedAt, false)).rejects.toMatchObject({
      status: 400,
    });
    await repository.delete(created.id, created.updatedAt, true);
    expect(await repository.get(created.id)).toBeUndefined();
    expect(await repository.get(builtin.id)).toEqual(builtin);
  });
  it('previews import before writing, requires conflict policy, and preserves existing manual edits', async () => {
    const first = await repository.create(definition());
    const second = await repository.create({ ...definition(), name: 'Second' });
    const backup = await repository.backup();
    await repository.delete(second.id, second.updatedAt, true);
    const edited = await repository.update(first.id, {
      expectedUpdatedAt: first.updatedAt,
      definition: { ...definition(), name: 'Keep manual edit' },
    });
    const before = await readFile(repository.filePath, 'utf8');
    const preview = await repository.importBackup(backup);
    expect(await readFile(repository.filePath, 'utf8')).toBe(before);
    expect(preview).toMatchObject({
      imported: 1,
      skipped: 1,
      committed: false,
      conflicts: [{ id: first.id, name: 'Custom template' }],
    });
    await expect(
      repository.importBackup(backup, { commit: true, expectedRevision: preview.revision }),
    ).rejects.toMatchObject({ status: 409 });
    const imported = await repository.importBackup(backup, {
      commit: true,
      expectedRevision: preview.revision,
      policy: 'skip',
    });
    expect(imported).toMatchObject({ imported: 1, skipped: 1, committed: true });
    expect(await repository.get(first.id)).toEqual(edited);
    expect(await repository.get(second.id)).toEqual(second);
  });
  it('refuses stale import revisions or unknown history versions without changing disk', async () => {
    const created = await repository.create(definition());
    const backup = await repository.backup();
    const preview = await repository.importBackup(backup);
    await repository.create({ ...definition(), name: 'Concurrent change' });
    const before = await readFile(repository.filePath, 'utf8');
    await expect(
      repository.importBackup(backup, {
        commit: true,
        expectedRevision: preview.revision,
        policy: 'skip',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      repository.update(created.id, {
        expectedUpdatedAt: created.updatedAt,
        restoreVersionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await readFile(repository.filePath, 'utf8')).toBe(before);
  });
  it('preserves corrupt data rather than silently replacing it', async () => {
    await writeFile(repository.filePath, '{broken:');
    await expect(repository.list()).rejects.toMatchObject({ status: 500 });
    await expect(repository.create(definition())).rejects.toMatchObject({ status: 500 });
    expect(await readFile(repository.filePath, 'utf8')).toBe('{broken:');
  });
  it('rejects untrusted properties, invalid backup formats, reserved IDs and oversized imports', async () => {
    const created = await repository.create(definition());
    const backup = await repository.backup();
    for (const invalid of [
      { ...backup, schemaVersion: 2 },
      { ...backup, apiKey: 'forbidden' },
      { ...backup, templates: [{ ...created, id: builtinTemplates[0]!.id }] },
      { ...backup, templates: [created, created] },
    ])
      await expect(repository.importBackup(invalid)).rejects.toMatchObject({ status: 400 });
    await expect(
      repository.importBackup({ padding: 'x'.repeat(25 * 1024 * 1024) }),
    ).rejects.toMatchObject({ status: 413 });
    expect(await repository.get(created.id)).toEqual(created);
  });
  it('does not silently truncate histories at the 50-version limit', async () => {
    const created = await repository.create(definition());
    const template = {
      ...created,
      versions: Array.from({ length: 50 }, () => ({ ...created.versions[0]!, id: randomUUID() })),
    };
    await writeFile(
      repository.filePath,
      JSON.stringify({ schemaVersion: 1, templates: [template] }),
    );
    const before = await readFile(repository.filePath, 'utf8');
    await expect(
      repository.update(created.id, { expectedUpdatedAt: created.updatedAt, favorite: true }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readFile(repository.filePath, 'utf8')).toBe(before);
  });
});
