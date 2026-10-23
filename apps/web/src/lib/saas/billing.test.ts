import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { closeDatabase, query } from './database';
import { withTenant } from './context';
import { subscription } from './entitlements';
import { handleStripeWebhook, createCheckout } from './billing';

const provider = vi.hoisted(() => ({ retrieve: vi.fn() }));
vi.mock('stripe', async (importOriginal) => {
  const original = await importOriginal<typeof import('stripe')>();
  return {
    default: class {
      webhooks = new original.default('sk_test_synthetic_offline_only').webhooks;
      subscriptions = { retrieve: provider.retrieve };
    },
  };
});
const owner = randomUUID();
const customer = `cus_webhook_${owner}`;
const subscriptionId = `sub_webhook_${owner}`;
const signingSecret = 'whsec_synthetic_test_value_not_a_credential';
let latest: Record<string, unknown>;
beforeAll(async () => {
  vi.stubEnv('PRODUCTSPY_MODE', 'saas');
  vi.stubEnv('PRODUCTSPY_DB_DRIVER', process.env.PRODUCTSPY_TEST_DATABASE_URL ? 'pg' : 'pglite');
  if (process.env.PRODUCTSPY_TEST_DATABASE_URL) {
    vi.stubEnv('DATABASE_URL', process.env.PRODUCTSPY_TEST_DATABASE_URL);
    vi.stubEnv('PRODUCTSPY_AUTO_MIGRATE', '0');
  } else vi.stubEnv('PRODUCTSPY_PGLITE_DIR', '');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic_offline_only');
  vi.stubEnv('STRIPE_PRICE_PRO', 'price_synthetic_pro');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', signingSecret);
  await query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    owner,
    `${owner}@example.invalid`,
    'synthetic',
  ]);
  await withTenant(owner, () =>
    query('INSERT INTO subscriptions(user_id,customer_id) VALUES($1,$2)', [owner, customer]),
  );
}, 30000);
beforeEach(async () => {
  vi.clearAllMocks();
  await withTenant(owner, () =>
    query(
      "UPDATE subscriptions SET plan='free',status='active',subscription_id=NULL,current_period_end=NULL WHERE user_id=$1",
      [owner],
    ),
  );
  latest = {
    id: subscriptionId,
    customer,
    metadata: { productspy_user_id: owner },
    status: 'active',
    items: {
      data: [
        {
          price: { id: 'price_synthetic_pro' },
          quantity: 1,
          current_period_end: Math.floor(Date.now() / 1000) + 3600,
        },
      ],
    },
  };
  provider.retrieve.mockImplementation(async () => latest);
});
afterAll(async () => {
  await withTenant(owner, () => query('DELETE FROM users WHERE id=$1', [owner]));
  await closeDatabase();
  vi.unstubAllEnvs();
});
async function eventPayload(overrides: Record<string, unknown> = {}, timestamp?: number) {
  const { default: Stripe } = await vi.importActual<typeof import('stripe')>('stripe');
  const raw = JSON.stringify({
    id: `evt_${randomUUID()}`,
    type: 'customer.subscription.updated',
    livemode: false,
    data: { object: { id: subscriptionId, metadata: { productspy_user_id: owner } } },
    ...overrides,
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: raw,
    secret: signingSecret,
    ...(timestamp ? { timestamp } : {}),
  });
  return { raw, signature };
}
describe('offline Stripe contract and real SDK signature verification (no sandbox transaction)', () => {
  it('rejects a tampered raw body and expired signature before any provider call', async () => {
    const sample = await eventPayload();
    await expect(handleStripeWebhook(`${sample.raw} `, sample.signature)).rejects.toMatchObject({
      status: 400,
    });
    const stale = await eventPayload({}, Math.floor(Date.now() / 1000) - 1000);
    await expect(handleStripeWebhook(stale.raw, stale.signature)).rejects.toMatchObject({
      status: 400,
    });
    expect(provider.retrieve).not.toHaveBeenCalled();
  });
  it('rejects live events when using sandbox credentials', async () => {
    const sample = await eventPayload({ livemode: true });
    await expect(handleStripeWebhook(sample.raw, sample.signature)).rejects.toMatchObject({
      status: 400,
    });
  });
  it('grants Pro from current provider state and deduplicates a signed event', async () => {
    const sample = await eventPayload();
    expect(await handleStripeWebhook(sample.raw, sample.signature)).toMatchObject({
      replayed: false,
    });
    provider.retrieve.mockRejectedValueOnce(new Error('synthetic provider unavailable on replay'));
    expect(await handleStripeWebhook(sample.raw, sample.signature)).toMatchObject({
      replayed: true,
    });
    expect(provider.retrieve).toHaveBeenCalledTimes(1);
    provider.retrieve.mockReset().mockImplementation(async () => latest);
    await withTenant(owner, async () => expect((await subscription()).plan).toBe('pro'));
    const count = await query<{ count: number }>(
      'SELECT count(*)::int AS count FROM webhook_events WHERE id=$1',
      [JSON.parse(sample.raw).id],
    );
    expect(count.rows[0].count).toBe(1);
  });
  it('does not grant Pro for an unrelated price or a past-due subscription', async () => {
    latest = { ...latest, items: { data: [{ price: { id: 'price_unrelated' }, quantity: 1 }] } };
    let sample = await eventPayload();
    await handleStripeWebhook(sample.raw, sample.signature);
    await withTenant(owner, async () => expect((await subscription()).plan).toBe('free'));
    latest = { ...latest, status: 'past_due' };
    sample = await eventPayload();
    await handleStripeWebhook(sample.raw, sample.signature);
    await withTenant(owner, async () => expect((await subscription()).plan).toBe('free'));
  });
  it('refuses a different Stripe customer and leaves the event eligible for retry', async () => {
    latest = { ...latest, customer: 'cus_another_account' };
    const sample = await eventPayload();
    await expect(handleStripeWebhook(sample.raw, sample.signature)).rejects.toMatchObject({
      status: 400,
    });
    expect(
      (await query('SELECT id FROM webhook_events WHERE id=$1', [JSON.parse(sample.raw).id])).rows,
    ).toHaveLength(0);
  });
  it('uses the current canceled state on a late active event', async () => {
    latest = { ...latest, status: 'canceled' };
    const sample = await eventPayload({ type: 'customer.subscription.created' });
    await handleStripeWebhook(sample.raw, sample.signature);
    await withTenant(owner, async () => expect((await subscription()).plan).toBe('free'));
  });
  it('fails closed when payment is not configured or live billing is not enabled', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    await expect(withTenant(owner, createCheckout)).rejects.toMatchObject({ status: 503 });
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_synthetic_blocked');
    vi.stubEnv('PRODUCTSPY_ENABLE_LIVE_BILLING', '0');
    await expect(withTenant(owner, createCheckout)).rejects.toMatchObject({ status: 503 });
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic_offline_only');
  });
  it('acknowledges an obsolete canceled subscription without downgrading its replacement', async () => {
    await withTenant(owner, () =>
      query(
        "UPDATE subscriptions SET plan='pro',status='active',subscription_id='sub_new',current_period_end=$1 WHERE user_id=$2",
        [new Date(Date.now() + 3600_000).toISOString(), owner],
      ),
    );
    latest = { ...latest, status: 'canceled' };
    const sample = await eventPayload({ type: 'customer.subscription.deleted' });
    expect(await handleStripeWebhook(sample.raw, sample.signature)).toMatchObject({
      ignored: true,
    });
    await withTenant(owner, async () =>
      expect(await subscription()).toMatchObject({ plan: 'pro', subscription_id: 'sub_new' }),
    );
  });
  it('replaces an old binding only after provider confirmation that it is terminal', async () => {
    await withTenant(owner, () =>
      query("UPDATE subscriptions SET subscription_id='sub_old' WHERE user_id=$1", [owner]),
    );
    provider.retrieve.mockImplementation(async (id: string) =>
      id === 'sub_old' ? { ...latest, id, status: 'active' } : latest,
    );
    const sample = await eventPayload();
    await expect(handleStripeWebhook(sample.raw, sample.signature)).rejects.toMatchObject({
      status: 409,
    });
    provider.retrieve.mockImplementation(async (id: string) =>
      id === 'sub_old' ? { ...latest, id, status: 'canceled' } : latest,
    );
    expect(await handleStripeWebhook(sample.raw, sample.signature)).toMatchObject({
      replayed: false,
    });
    await withTenant(owner, async () =>
      expect(await subscription()).toMatchObject({ plan: 'pro', subscription_id: subscriptionId }),
    );
  });
});
