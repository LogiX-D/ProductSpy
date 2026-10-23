import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, query } from './database';
import { withTenant } from './context';
import { createCheckout, reconcileBilling } from './billing';
import { subscription } from './entitlements';
import { tokenHash } from './security';
import { POST as reconcileRoute } from '../../app/api/billing/reconcile/route';

const provider = vi.hoisted(() => ({
  create: vi.fn(),
  retrieveSession: vi.fn(),
  list: vi.fn(),
  retrieveSubscription: vi.fn(),
}));
vi.mock('stripe', () => ({
  default: class {
    subscriptions = { list: provider.list, retrieve: provider.retrieveSubscription };
    checkout = { sessions: { create: provider.create, retrieve: provider.retrieveSession } };
  },
}));
const owner = randomUUID();
const otherOwner = randomUUID();
const token = randomBytes(32).toString('hex');
const sessions = new Map<string, Record<string, unknown>>();
let loseResponse = false;
beforeAll(async () => {
  vi.stubEnv('PRODUCTSPY_MODE', 'saas');
  vi.stubEnv('PRODUCTSPY_DB_DRIVER', process.env.PRODUCTSPY_TEST_DATABASE_URL ? 'pg' : 'pglite');
  if (process.env.PRODUCTSPY_TEST_DATABASE_URL) {
    vi.stubEnv('DATABASE_URL', process.env.PRODUCTSPY_TEST_DATABASE_URL);
    vi.stubEnv('PRODUCTSPY_AUTO_MIGRATE', '0');
  } else vi.stubEnv('PRODUCTSPY_PGLITE_DIR', '');
  vi.stubEnv('PRODUCTSPY_APP_URL', 'https://productspy.example.invalid');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic_offline_only');
  vi.stubEnv('STRIPE_PRICE_PRO', 'price_synthetic_pro');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_synthetic_offline_only');
  await query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    owner,
    `${owner}@example.invalid`,
    'synthetic',
  ]);
  await query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
    otherOwner,
    `${otherOwner}@example.invalid`,
    'synthetic',
  ]);
  await withTenant(otherOwner, () =>
    query('INSERT INTO subscriptions(user_id,customer_id) VALUES($1,$2)', [
      otherOwner,
      `cus_${otherOwner}`,
    ]),
  );
  await query("INSERT INTO sessions(token_hash,user_id,kind,expires_at) VALUES($1,$2,'web',$3)", [
    tokenHash(token),
    owner,
    new Date(Date.now() + 3600_000).toISOString(),
  ]);
}, 30000);
beforeEach(async () => {
  vi.clearAllMocks();
  await withTenant(owner, async () => {
    await query('DELETE FROM subscriptions WHERE user_id=$1', [owner]);
    await query("INSERT INTO subscriptions(user_id,customer_id) VALUES($1,'cus_synthetic')", [
      owner,
    ]);
  });
  sessions.clear();
  loseResponse = false;
  provider.list.mockResolvedValue({ data: [], has_more: false });
  provider.retrieveSession.mockImplementation(async (id: string) =>
    [...sessions.values()].find((session) => session.id === id),
  );
  provider.create.mockImplementation(
    async (input, { idempotencyKey }: { idempotencyKey: string }) => {
      let session = sessions.get(idempotencyKey);
      if (!session) {
        const created: Record<string, unknown> = {
          id: `cs_${randomUUID()}`,
          url: `https://checkout.stripe.com/synthetic/${randomUUID()}`,
          status: 'open',
          ...input,
        };
        sessions.set(idempotencyKey, created);
        session = created;
      }
      if (loseResponse) {
        loseResponse = false;
        throw new Error('synthetic response lost after provider accepted request');
      }
      return session;
    },
  );
});
afterAll(async () => {
  await withTenant(owner, () => query('DELETE FROM users WHERE id=$1', [owner]));
  await withTenant(otherOwner, () => query('DELETE FROM users WHERE id=$1', [otherOwner]));
  await closeDatabase();
  vi.unstubAllEnvs();
});

function providerSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_synthetic',
    customer: 'cus_synthetic',
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
    ...overrides,
  };
}

describe('checkout recovery with an offline provider (no payment or Stripe HTTP)', () => {
  it('reuses an open checkout when a retry crosses the hour boundary', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000 * 3600_000 + 3500_000);
    const first = await withTenant(owner, createCheckout);
    clock.mockReturnValue(Date.now() + 200_000);
    expect(await withTenant(owner, createCheckout)).toEqual(first);
    expect(sessions.size).toBe(1);
  });
  it('starts a new attempt after a checkout expires within the same hour', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000_000 * 3600_000 + 1000);
    const first = await withTenant(owner, createCheckout);
    [...sessions.values()][0].status = 'expired';
    expect(await withTenant(owner, createCheckout)).not.toEqual(first);
    expect(sessions.size).toBe(2);
  });
  it('recovers the accepted checkout after losing its response across an hour boundary', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000 * 3600_000 + 3500_000);
    loseResponse = true;
    await expect(withTenant(owner, createCheckout)).rejects.toThrow('response lost');
    const first = [...sessions.values()][0];
    clock.mockReturnValue(Date.now() + 200_000);
    expect(await withTenant(owner, createCheckout)).toEqual({ url: first.url });
    expect(sessions.size).toBe(1);
  });
  it('serializes simultaneous requests to the same checkout', async () => {
    const [first, second] = await Promise.all([
      withTenant(owner, createCheckout),
      withTenant(owner, createCheckout),
    ]);
    expect(first).toEqual(second);
    expect(sessions.size).toBe(1);
  });
  it('replays the exact persisted payload when configuration changes after a lost response', async () => {
    loseResponse = true;
    await expect(withTenant(owner, createCheckout)).rejects.toThrow('response lost');
    const input = provider.create.mock.calls[0][0];
    vi.stubEnv('STRIPE_PRICE_PRO', 'price_changed_after_deploy');
    vi.stubEnv('PRODUCTSPY_APP_URL', 'https://changed.example.invalid');
    try {
      await withTenant(owner, createCheckout);
      expect(provider.create.mock.calls[1][0]).toEqual(input);
      expect(sessions.size).toBe(1);
    } finally {
      vi.stubEnv('STRIPE_PRICE_PRO', 'price_synthetic_pro');
      vi.stubEnv('PRODUCTSPY_APP_URL', 'https://productspy.example.invalid');
    }
  });
  it('refuses to replay an unknown response after the safe idempotency window', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000 * 3600_000);
    loseResponse = true;
    await expect(withTenant(owner, createCheckout)).rejects.toThrow('response lost');
    clock.mockReturnValue(Date.now() + 24 * 3600_000);
    await expect(withTenant(owner, createCheckout)).rejects.toMatchObject({ status: 409 });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(1);
  });
  it('starts a new checkout after a completed subscription has been confirmed canceled', async () => {
    const first = await withTenant(owner, createCheckout);
    Object.assign([...sessions.values()][0], { status: 'complete', subscription: 'sub_synthetic' });
    provider.list.mockResolvedValue({
      data: [providerSubscription({ status: 'canceled' })],
      has_more: false,
    });
    await withTenant(owner, () =>
      query(
        "UPDATE subscriptions SET subscription_id='sub_synthetic',status='canceled' WHERE user_id=$1",
        [owner],
      ),
    );
    expect(await withTenant(owner, createCheckout)).not.toEqual(first);
    expect(sessions.size).toBe(2);
  });
  it('blocks a duplicate subscription while a webhook is delayed and reconciles Pro safely', async () => {
    provider.list.mockResolvedValue({ data: [providerSubscription()], has_more: false });
    await expect(withTenant(owner, createCheckout)).rejects.toMatchObject({ status: 409 });
    expect(provider.create).not.toHaveBeenCalled();
    expect(await withTenant(owner, reconcileBilling)).toEqual({ reconciled: true });
    await withTenant(owner, async () => expect((await subscription()).plan).toBe('pro'));
    provider.list.mockResolvedValue({
      data: [providerSubscription({ status: 'canceled' })],
      has_more: false,
    });
    await withTenant(owner, reconcileBilling);
    await withTenant(owner, async () => expect((await subscription()).plan).toBe('free'));
  });
  it.each(['past_due', 'unpaid', 'incomplete', 'paused'])(
    'blocks another checkout for a %s subscription',
    async (status) => {
      provider.list.mockResolvedValue({
        data: [providerSubscription({ status })],
        has_more: false,
      });
      await expect(withTenant(owner, createCheckout)).rejects.toMatchObject({ status: 409 });
      expect(provider.create).not.toHaveBeenCalled();
    },
  );
  it('requires matching owner, price, quantity and a future period for Pro', async () => {
    for (const item of [
      {
        price: { id: 'price_other' },
        quantity: 1,
        current_period_end: Math.floor(Date.now() / 1000) + 3600,
      },
      {
        price: { id: 'price_synthetic_pro' },
        quantity: 2,
        current_period_end: Math.floor(Date.now() / 1000) + 3600,
      },
      { price: { id: 'price_synthetic_pro' }, quantity: 1 },
      {
        price: { id: 'price_synthetic_pro' },
        quantity: 1,
        current_period_end: Math.floor(Date.now() / 1000) - 1,
      },
    ]) {
      provider.list.mockResolvedValue({
        data: [providerSubscription({ items: { data: [item] } })],
        has_more: false,
      });
      await withTenant(owner, reconcileBilling);
      await withTenant(owner, async () => expect((await subscription()).plan).toBe('free'));
    }
    provider.list.mockResolvedValue({
      data: [providerSubscription({ metadata: { productspy_user_id: randomUUID() } })],
      has_more: false,
    });
    await expect(withTenant(owner, reconcileBilling)).rejects.toMatchObject({ status: 400 });
  });
  it('fails closed on duplicate provider subscriptions or incomplete pagination', async () => {
    provider.list.mockResolvedValue({
      data: [providerSubscription(), providerSubscription({ id: 'sub_other' })],
      has_more: false,
    });
    await expect(withTenant(owner, createCheckout)).rejects.toMatchObject({ status: 409 });
    provider.list.mockResolvedValue({ data: [], has_more: true });
    await expect(withTenant(owner, createCheckout)).rejects.toMatchObject({ status: 503 });
    expect(provider.create).not.toHaveBeenCalled();
  });
  it('rejects a returned checkout belonging to another customer', async () => {
    await withTenant(owner, createCheckout);
    [...sessions.values()][0].customer = 'cus_foreign';
    await expect(withTenant(owner, createCheckout)).rejects.toMatchObject({ status: 400 });
    expect(sessions.size).toBe(1);
  });
  it('protects reconciliation from anonymous, cross-origin and extension requests and ignores client entitlement fields', async () => {
    const request = (headers: Record<string, string>) =>
      new Request('https://productspy.example.invalid/api/billing/reconcile', {
        method: 'POST',
        headers: {
          host: 'productspy.example.invalid',
          origin: 'https://productspy.example.invalid',
          'x-productspy-client': 'web',
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ userId: otherOwner, plan: 'pro', subscriptionId: 'sub_untrusted' }),
      });
    expect((await reconcileRoute(request({}))).status).toBe(401);
    expect(
      (
        await reconcileRoute(
          request({
            cookie: `productspy_account=${token}`,
            origin: 'https://foreign.example.invalid',
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await reconcileRoute(
          request({
            origin: `chrome-extension://${'a'.repeat(32)}`,
            'x-productspy-client': 'extension',
            authorization: `Bearer ${token}`,
          }),
        )
      ).status,
    ).toBe(403);
    expect(provider.list).not.toHaveBeenCalled();
    provider.list.mockResolvedValue({ data: [providerSubscription()], has_more: false });
    const response = await reconcileRoute(request({ cookie: `productspy_account=${token}` }));
    expect(response.status).toBe(200);
    await withTenant(owner, async () => expect((await subscription()).plan).toBe('pro'));
    await withTenant(otherOwner, async () => expect((await subscription()).plan).toBe('free'));
    expect(provider.list.mock.calls[0][0].customer).toBe('cus_synthetic');
  });
});
