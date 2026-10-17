import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  composeOverride,
  configuration,
  validateModel,
  validateOwnership,
} from './verify-compose.mjs';

const execute = promisify(execFile);
const script = resolve('scripts/saas/verify-compose.mjs');
const runId = '1'.repeat(32);
const project = `productspy-compose-${runId}`;
const databaseUrl = 'postgresql://productspy_app:synthetic-test-password@db:5432/productspy';
const marker = { 'productspy.compose.verification': runId };
const options = { project, runId, databaseUrl };
function model() {
  const application = (image) => ({
    image,
    labels: { ...marker },
    depends_on: { db: { condition: 'service_healthy' } },
    environment: {
      DATABASE_URL: databaseUrl,
      PRODUCTSPY_JOB_RUNNER: 'external',
      PRODUCTSPY_AUTO_MIGRATE: '0',
      AI_MODE: 'mock',
      AI_API_KEY: '',
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      STRIPE_PRICE_PRO: '',
      PRODUCTSPY_ENABLE_LIVE_BILLING: '0',
    },
  });
  return {
    name: project,
    services: {
      db: {
        image: 'postgres:17-bookworm',
        labels: { ...marker },
        volumes: [{ type: 'volume', source: 'postgres-data', target: '/var/lib/postgresql/data' }],
      },
      web: {
        ...application('productspy-web:ci'),
        ports: [{ host_ip: '127.0.0.1', published: '0', target: 3000 }],
      },
      worker: application('productspy-worker:ci'),
    },
    volumes: { 'postgres-data': { name: `${project}_postgres-data`, labels: { ...marker } } },
    networks: { default: { name: `${project}_default`, labels: { ...marker } } },
  };
}

describe('isolated Compose verification boundaries (no Docker execution)', () => {
  it('requires explicit opt-in before any Docker command', async () => {
    const result = await execute(process.execPath, [script], {
      env: { ...process.env, PRODUCTSPY_COMPOSE_VERIFY: '' },
      windowsHide: true,
    }).then(
      () => ({ code: 0 }),
      (error) => ({ code: error.code, stderr: error.stderr }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Set PRODUCTSPY_COMPOSE_VERIFY=1');
  });

  it('refuses remote Docker and externally selected Compose projects or files', () => {
    for (const key of [
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'DOCKER_TLS_VERIFY',
      'DOCKER_CERT_PATH',
      'COMPOSE_FILE',
      'COMPOSE_PROJECT_NAME',
      'COMPOSE_PROFILES',
      'COMPOSE_ENV_FILES',
      'COMPOSE_DISABLE_ENV_FILE',
    ]) {
      expect(() =>
        configuration({ PRODUCTSPY_COMPOSE_VERIFY: '1', [key]: 'synthetic-secret-never-echo' }),
      ).toThrow(`Overridden Docker or Compose configuration ${key} is forbidden`);
      try {
        configuration({ PRODUCTSPY_COMPOSE_VERIFY: '1', [key]: 'synthetic-secret-never-echo' });
      } catch (error) {
        expect(error.message).not.toContain('synthetic-secret-never-echo');
      }
    }
  });

  it('requires GitHub Linux execution and the current checkout revision', () => {
    const env = { PRODUCTSPY_COMPOSE_VERIFY: '1' };
    expect(() => configuration(env, 'linux')).toThrow('only inside GitHub Actions');
    env.GITHUB_ACTIONS = 'true';
    env.RUNNER_OS = 'Windows';
    expect(() => configuration(env, 'linux')).toThrow('Linux CI runner');
    env.RUNNER_OS = 'Linux';
    expect(() => configuration(env, 'win32')).toThrow('Linux CI runner');
    expect(() => configuration(env, 'linux')).toThrow('Current GitHub commit SHA required');
    env.GITHUB_SHA = 'a'.repeat(40);
    expect(configuration(env, 'linux')).toEqual({ revision: env.GITHUB_SHA });
  });

  it('replaces rather than appends both env_files and the public port', () => {
    const override = composeOverride('/tmp/private-compose/synthetic.env', runId);
    expect(override.match(/env_file: !override/g)).toHaveLength(2);
    expect(override).toContain('ports: !override ["127.0.0.1:0:3000"]');
    expect(override).not.toContain('.env.production');
    expect(override).not.toContain('command:');
    expect(override).not.toContain('network_mode:');
    expect(() => composeOverride('relative.env', runId)).toThrow('Absolute CI file required');
    expect(() => composeOverride('/tmp/env\nservices:', runId)).toThrow(
      'Absolute CI file required',
    );
    expect(() => composeOverride('/tmp/env', 'production')).toThrow('Invalid isolated run marker');
  });

  it('accepts the intended privately bound resolved original service model', () => {
    expect(() => validateModel(model(), options)).not.toThrow();
  });

  it('rejects public or additional ports, including accidental original port merging', () => {
    const publicWeb = model();
    publicWeb.services.web.ports[0].host_ip = '0.0.0.0';
    expect(() => validateModel(publicWeb, options)).toThrow('IPv4 loopback');
    const merged = model();
    merged.services.web.ports.push({ host_ip: '127.0.0.1', published: '3000', target: 3000 });
    expect(() => validateModel(merged, options)).toThrow('Only one private web port');
    for (const name of ['db', 'worker']) {
      const published = model();
      published.services[name].ports = [{ published: '5432', target: 5432 }];
      expect(() => validateModel(published, options)).toThrow('host ports forbidden');
    }
  });

  it('rejects inherited production credentials or enabled external providers without echoing secrets', () => {
    for (const name of ['web', 'worker']) {
      const inherited = model();
      inherited.services[name].environment.DATABASE_URL =
        'postgresql://private-secret@production/db';
      expect(() => validateModel(inherited, options)).toThrow('Synthetic app DB URL required');
      try {
        validateModel(inherited, options);
      } catch (error) {
        expect(error.message).not.toContain('private-secret');
      }
      for (const key of [
        'AI_API_KEY',
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
        'STRIPE_PRICE_PRO',
      ]) {
        const credentials = model();
        credentials.services[name].environment[key] = 'private-secret';
        expect(() => validateModel(credentials, options)).toThrow(
          'External provider credentials forbidden',
        );
      }
      const realAI = model();
      realAI.services[name].environment.AI_MODE = 'real';
      expect(() => validateModel(realAI, options)).toThrow('Only Mock AI is allowed');
    }
  });

  it('refuses altered commands, images or privileged networking instead of weakening the original workload', () => {
    const command = model();
    command.services.worker.command = ['true'];
    expect(() => validateModel(command, options)).toThrow('Original image command');
    const image = model();
    image.services.web.image = 'external.example.invalid/app:latest';
    expect(() => validateModel(image, options)).toThrow('prebuilt local business images');
    for (const key of ['privileged', 'network_mode']) {
      const unsafe = model();
      unsafe.services.worker[key] = key === 'privileged' ? true : 'host';
      expect(() => validateModel(unsafe, options)).toThrow(
        'Privileged or host networking forbidden',
      );
    }
  });

  it('requires run markers and the original persistent volume and service network', () => {
    for (const type of ['volumes', 'networks']) {
      const unsafe = model();
      const key = type === 'volumes' ? 'postgres-data' : 'default';
      unsafe[type][key].labels = {};
      expect(() => validateModel(unsafe, options)).toThrow();
      const reused = model();
      reused[type][key].name = 'production-data';
      expect(() => validateModel(reused, options)).toThrow();
    }
    const mount = model();
    mount.services.db.volumes[0].type = 'bind';
    expect(() => validateModel(mount, options)).toThrow();
  });

  it('requires both actual project ownership and the exact run marker before cleanup', () => {
    const labels = { 'com.docker.compose.project': project, ...marker };
    expect(() => validateOwnership(labels, project, runId)).not.toThrow();
    expect(() => validateOwnership(undefined, project, runId)).toThrow('ownership labels missing');
    expect(() => validateOwnership(marker, project, runId)).toThrow('project ownership changed');
    expect(() =>
      validateOwnership({ 'com.docker.compose.project': project }, project, runId),
    ).toThrow('run marker changed');
    expect(() =>
      validateOwnership(
        { ...labels, 'productspy.compose.verification': '2'.repeat(32) },
        project,
        runId,
      ),
    ).toThrow('run marker changed');
  });
});
