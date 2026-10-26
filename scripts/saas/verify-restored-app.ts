import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  builtinTemplates,
  templateDefinition,
  productSchema,
  workspaceBackupSchema,
  type ApiResult,
  type Product,
  type WorkspaceBackup,
} from '../../packages/shared/src/index';
import { query, closeDatabase } from '../../apps/web/src/lib/saas/database';
import { runAIJob } from '../../apps/web/src/lib/saas/job-worker';
import { POST as register } from '../../apps/web/src/app/api/auth/register/route';
import { POST as login } from '../../apps/web/src/app/api/auth/login/route';
import { GET as me } from '../../apps/web/src/app/api/auth/me/route';
import { POST as capture, GET as products } from '../../apps/web/src/app/api/products/route';
import { GET as productGet } from '../../apps/web/src/app/api/products/[id]/route';
import { GET as historyGet } from '../../apps/web/src/app/api/products/[id]/analysis-history/route';
import { POST as enqueue } from '../../apps/web/src/app/api/jobs/route';
import { GET as jobGet } from '../../apps/web/src/app/api/jobs/[id]/route';
import { POST as templateCreate } from '../../apps/web/src/app/api/templates/route';
import { POST as comparisonCreate } from '../../apps/web/src/app/api/comparisons/route';
import { POST as contentCreate } from '../../apps/web/src/app/api/content-plans/route';
import { GET as backupGet } from '../../apps/web/src/app/api/workspace-backup/route';
import { POST as codeCreate } from '../../apps/web/src/app/api/bridge/code/route';
import { POST as pair } from '../../apps/web/src/app/api/bridge/pair/route';

type Handler = (request: Request) => Promise<Response>;
interface Credentials {
  email: string;
  password: string;
}
interface AccountEvidence {
  userId: string;
  productId: string;
  completedJobId: string;
  queuedJobId: string;
  productSha256: string;
  historySha256: string;
  businessExportSha256: string;
}
const origin = 'http://127.0.0.1:3100';
class VerificationError extends Error {}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
const checksum = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
function request(path: string, method = 'GET', body?: unknown, cookie = '', extension = false) {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      Host: new URL(origin).host,
      Origin: extension ? `chrome-extension://${'a'.repeat(32)}` : origin,
      'Sec-Fetch-Site': extension ? 'none' : 'same-origin',
      'X-ProductSpy-Client': extension ? 'extension' : 'web',
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function data<T>(response: Response, status = 200): Promise<T> {
  assert(
    response.status === status,
    `Application route returned HTTP ${response.status}; expected ${status}.`,
  );
  const result = (await response.json()) as ApiResult<T>;
  assert(result.ok, 'Application route returned a failed API envelope.');
  return result.data;
}
function cookie(response: Response): string {
  const value = response.headers.get('set-cookie');
  assert(
    typeof value === 'string' && value.includes('HttpOnly'),
    'The application did not issue an HttpOnly browser session.',
  );
  return value.split(';')[0];
}
async function call<T>(
  handler: Handler,
  path: string,
  method: string,
  body: unknown,
  session: string,
  status = 200,
) {
  return data<T>(await handler(request(path, method, body, session)), status);
}
async function inspectAccount(
  session: string,
  expected: Pick<AccountEvidence, 'userId' | 'productId' | 'completedJobId' | 'queuedJobId'>,
): Promise<AccountEvidence> {
  const summary = await call<{
    user: { id: string };
    usage: { products: number };
    subscription: { plan: string };
  }>(me, '/api/auth/me', 'GET', undefined, session);
  assert(
    summary.user.id === expected.userId && summary.usage.products === 2,
    'Restored account or product count differs.',
  );
  assert(summary.subscription.plan === 'free', 'Synthetic Free subscription was not preserved.');
  const listing = await call<Product[]>(products, '/api/products', 'GET', undefined, session);
  assert(listing.length === 2, 'Expected two valid application products.');
  const path = `/api/products/${encodeURIComponent(expected.productId)}`;
  const product = productSchema.parse(
    await data<Product>(
      await productGet(request(path, 'GET', undefined, session), context(expected.productId)),
    ),
  );
  assert(
    product.analysisMetadata?.mode === 'mock' && (product.analysisHistory?.length ?? 0) === 1,
    'A saved Mock analysis and history are required.',
  );
  const history = await data<unknown[]>(
    await historyGet(
      request(`${path}/analysis-history`, 'GET', undefined, session),
      context(expected.productId),
    ),
  );
  assert(history.length === 1, 'Application analysis-history route is empty.');
  const backup = workspaceBackupSchema.parse(
    await call<WorkspaceBackup>(backupGet, '/api/workspace-backup', 'GET', undefined, session),
  );
  assert(
    backup.library.products.length === 2 &&
      backup.templates.length === 1 &&
      backup.comparisons.length === 1 &&
      backup.contentPlans.length === 1,
    'Application export lost a business resource.',
  );
  const completed = await data<{ status: string }>(
    await jobGet(
      request(`/api/jobs/${expected.completedJobId}`, 'GET', undefined, session),
      context(expected.completedJobId),
    ),
  );
  const queued = await data<{ status: string }>(
    await jobGet(
      request(`/api/jobs/${expected.queuedJobId}`, 'GET', undefined, session),
      context(expected.queuedJobId),
    ),
  );
  assert(
    completed.status === 'succeeded' && queued.status === 'queued',
    'Completed and queued task states were not preserved.',
  );
  // Export creation time is intentionally new. The full exported business model is compared.
  const business = Object.fromEntries(
    Object.entries(backup).filter(([key]) => key !== 'exportedAt'),
  );
  return {
    ...expected,
    productSha256: checksum(product),
    historySha256: checksum(history),
    businessExportSha256: checksum(business),
  };
}
async function main() {
  assert(
    process.env.PRODUCTSPY_RESTORED_APP_VERIFY === '1',
    'Set PRODUCTSPY_RESTORED_APP_VERIFY=1 explicitly.',
  );
  const action = process.env.PRODUCTSPY_RECOVERY_ACTION;
  assert(
    action === 'seed' || action === 'read',
    'Choose the explicit seed or read verification action.',
  );
  let database: URL;
  try {
    database = new URL(process.env.DATABASE_URL ?? '');
  } catch {
    throw new VerificationError('Invalid isolated recovery database URL; credentials omitted.');
  }
  assert(
    ['postgres:', 'postgresql:'].includes(database.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname),
    'Only a loopback PostgreSQL recovery database is allowed.',
  );
  assert(
    !database.search && !database.hash,
    'Database connection options and fragments are forbidden.',
  );
  assert(database.username, 'An explicit restricted application role is required.');
  if (database.hostname === 'localhost') database.hostname = '127.0.0.1';
  const name = database.pathname.match(/^\/productspy_logical_(source|target)_([a-f0-9]{32})$/);
  assert(
    name && name[1] === (action === 'seed' ? 'source' : 'target'),
    'Use only the owned source or target recovery database for this action.',
  );
  let credentials: Credentials[];
  try {
    credentials = JSON.parse(process.env.PRODUCTSPY_RECOVERY_CREDENTIALS ?? '') as Credentials[];
  } catch {
    throw new VerificationError(
      'Provide synthetic recovery credentials through the environment only.',
    );
  }
  assert(
    Array.isArray(credentials) &&
      credentials.length === 2 &&
      credentials.every(
        (account, index) =>
          account.email === `logical-recovery-${index}-${name[2]}@example.invalid` &&
          /^Synthetic-recovery-[a-f0-9]{64}$/.test(account.password),
      ),
    'Only two run-specific synthetic recovery accounts are allowed.',
  );
  Object.assign(process.env, {
    DATABASE_URL: database.href,
    PRODUCTSPY_MODE: 'saas',
    PRODUCTSPY_ENV: 'test',
    PRODUCTSPY_APP_URL: origin,
    PRODUCTSPY_DB_DRIVER: 'pg',
    PRODUCTSPY_AUTO_MIGRATE: '0',
    DB_MIGRATE_ON_START: '0',
    PRODUCTSPY_JOB_RUNNER: 'external',
    AI_MODE: 'mock',
    AI_API_KEY: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_PRICE_PRO: '',
    STRIPE_WEBHOOK_SECRET: '',
    PRODUCTSPY_ENABLE_LIVE_BILLING: '0',
    PRODUCTSPY_ARCHIVE_SECRET: 'synthetic-recovery-archive-secret-unused-in-production',
  });
  const role = (
    await query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    )
  ).rows[0];
  assert(role && !role.rolsuper && !role.rolbypassrls, 'Use a restricted application role.');
  const sessions: string[] = [];
  const evidence: AccountEvidence[] = [];
  let expected: AccountEvidence[] = [];
  if (action === 'read') {
    try {
      expected = JSON.parse(process.env.PRODUCTSPY_RECOVERY_EXPECTED ?? '') as AccountEvidence[];
    } catch {
      throw new VerificationError('Missing source application verification evidence.');
    }
    assert(
      Array.isArray(expected) &&
        expected.length === 2 &&
        expected.every(
          (item) =>
            Object.keys(item).length === 7 &&
            /^[a-f0-9-]{36}$/.test(item.userId) &&
            /^amazon:B[A-Z0-9]{9}$/.test(item.productId) &&
            [item.completedJobId, item.queuedJobId].every((id) => /^[a-f0-9-]{36}$/.test(id)) &&
            [item.productSha256, item.historySha256, item.businessExportSha256].every((digest) =>
              /^[a-f0-9]{64}$/.test(digest),
            ),
        ),
      'Valid synthetic source account evidence is required.',
    );
  } else
    assert(
      (await query<{ count: number }>('SELECT count(*)::integer AS count FROM users')).rows[0]
        .count === 0,
      'The owned source database is not empty.',
    );
  for (const [index, account] of credentials.entries()) {
    if (action === 'seed') {
      const registration = await register(
        request('/api/auth/register', 'POST', { ...account, name: 'Synthetic Logical Recovery' }),
      );
      const owner = await data<{ user: { id: string } }>(registration);
      const session = cookie(registration);
      sessions.push(session);
      const captured: Product[] = [];
      for (let item = 0; item < 2; item++) {
        const asin = ['B044444444', 'B055555555', 'B066666666', 'B077777777'][index * 2 + item];
        captured.push(
          await call<Product>(
            capture,
            '/api/products',
            'POST',
            {
              source: 'amazon',
              sourceId: asin,
              url: `https://www.amazon.com/dp/${asin}`,
              title: `Synthetic recovery tenant ${index + 1} product ${item + 1}`,
              images: [],
              videos: [],
              bulletPoints: ['Synthetic recovery fixture; no Amazon request'],
            },
            session,
          ),
        );
      }
      const completedJobId = randomUUID();
      await call(
        enqueue,
        '/api/jobs',
        'POST',
        {
          endpoint: '/api/analyze-product',
          input: {
            requestId: completedJobId,
            product: captured[0],
            options: DEFAULT_ANALYSIS_OPTIONS,
          },
        },
        session,
        202,
      );
      assert(
        await runAIJob(owner.user.id, completedJobId),
        'The source Mock analysis worker did not run.',
      );
      const saved = await data<Product>(
        await productGet(
          request(`/api/products/${encodeURIComponent(captured[0].id)}`, 'GET', undefined, session),
          context(captured[0].id),
        ),
      );
      const template = await call<{ id: string }>(
        templateCreate,
        '/api/templates',
        'POST',
        { ...templateDefinition(builtinTemplates[0]), name: 'Synthetic recovery template' },
        session,
      );
      await call(
        comparisonCreate,
        '/api/comparisons',
        'POST',
        {
          name: 'Synthetic recovery comparison',
          productIds: captured.map((product) => product.id),
        },
        session,
      );
      await call(
        contentCreate,
        '/api/content-plans',
        'POST',
        { name: 'Synthetic recovery content', productId: saved.id, templateId: template.id },
        session,
      );
      const queuedJobId = randomUUID();
      await call(
        enqueue,
        '/api/jobs',
        'POST',
        {
          endpoint: '/api/analyze-product',
          input: { requestId: queuedJobId, product: saved, options: DEFAULT_ANALYSIS_OPTIONS },
        },
        session,
        202,
      );
      const authorization = await call<{ code: string }>(
        codeCreate,
        '/api/bridge/code',
        'POST',
        { extensionOrigin: `chrome-extension://${'a'.repeat(32)}` },
        session,
      );
      await data(
        await pair(request('/api/bridge/pair', 'POST', { code: authorization.code }, '', true)),
      );
      evidence.push(
        await inspectAccount(session, {
          userId: owner.user.id,
          productId: saved.id,
          completedJobId,
          queuedJobId,
        }),
      );
    } else {
      const invalid = await login(
        request('/api/auth/login', 'POST', {
          email: account.email,
          password: 'Wrong-synthetic-recovery-password',
        }),
      );
      assert(invalid.status === 401, 'Restored authentication accepted a wrong password.');
      const signedIn = await login(request('/api/auth/login', 'POST', account));
      const owner = await data<{ user: { id: string } }>(signedIn);
      assert(owner.user.id === expected[index].userId, 'Restored login returned another account.');
      const session = cookie(signedIn);
      sessions.push(session);
      const actual = await inspectAccount(session, expected[index]);
      assert.deepEqual(
        actual,
        expected[index],
        'Restored product, history or business export differs.',
      );
      evidence.push(actual);
    }
  }
  for (let index = 0; index < sessions.length; index++) {
    const other = evidence[1 - index];
    const denied = await productGet(
      request(
        `/api/products/${encodeURIComponent(other.productId)}`,
        'GET',
        undefined,
        sessions[index],
      ),
      context(other.productId),
    );
    assert(denied.status === 404, 'Recovery application route exposed another account product.');
  }
  console.log(
    JSON.stringify({
      action,
      scope:
        'Actual in-process Next route handlers with Request/Response and real restricted-role PostgreSQL; no HTTP, cloud, TLS or physical devices',
      ai: 'Mock only, no external AI/payment provider calls',
      accounts: evidence,
      checks:
        action === 'seed'
          ? [
              'actual registration/password hash',
              'actual product/template/comparison/content model writes',
              'actual queued worker Mock analysis',
              'valid business export',
              'two-user route isolation',
            ]
          : [
              'restored wrong-password rejection',
              'restored actual login and new HttpOnly sessions',
              'identical saved product and Mock history',
              'identical validated business export excluding new exportedAt',
              'preserved completed and queued tasks',
              'two-user route isolation',
            ],
      expectedWrites:
        action === 'read'
          ? 'Two new browser sessions and API/auth rate-limit updates; business rows must remain unchanged'
          : 'Synthetic source application data',
    }),
  );
}
void main()
  .catch((error: unknown) => {
    console.error(
      error instanceof assert.AssertionError || error instanceof VerificationError
        ? error.message
        : 'Restored application verification failed; credentials and response bodies omitted.',
    );
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
