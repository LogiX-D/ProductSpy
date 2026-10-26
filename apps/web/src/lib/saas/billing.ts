import Stripe from 'stripe';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { query, dbTransaction } from './database';
import { currentUserId, withTenant } from './context';
import { subscription } from './entitlements';
import { appOrigin } from './config';
import { AppError } from '../server/errors';

function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !process.env.STRIPE_PRICE_PRO || !process.env.STRIPE_WEBHOOK_SECRET)
    throw new AppError(503, '订阅支付尚未配置，请联系维护者；当前仍可使用 Free 套餐');
  if (!/^(sk|rk)_test_/.test(key) && process.env.PRODUCTSPY_ENABLE_LIVE_BILLING !== '1')
    throw new AppError(503, '真实支付尚未授权启用');
  return new Stripe(key, { maxNetworkRetries: 0, timeout: 15000 });
}

const terminal = (status: string) => ['canceled', 'incomplete_expired'].includes(status);
function assertOwner(latest: Stripe.Subscription, customer: string, userId: string) {
  const providerCustomer =
    typeof latest.customer === 'string' ? latest.customer : latest.customer.id;
  if (latest.metadata.productspy_user_id !== userId || providerCustomer !== customer)
    throw new AppError(400, '订阅客户或用户归属与当前账号不匹配');
}

/** A customer can have multiple historical subscriptions, but only one nonterminal subscription. */
async function providerSubscriptions(stripe: Stripe, customer: string, userId: string) {
  const subscriptions: Stripe.Subscription[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await stripe.subscriptions.list({
      customer,
      status: 'all',
      limit: 100,
      ...(after ? { starting_after: after } : {}),
    });
    for (const item of result.data) assertOwner(item, customer, userId);
    subscriptions.push(...result.data);
    if (!result.has_more) {
      if (subscriptions.filter((item) => !terminal(item.status)).length > 1)
        throw new AppError(409, '支付平台存在多个待处理订阅，请联系维护者核对账单');
      return subscriptions;
    }
    const next = result.data.at(-1)?.id;
    if (!next || next === after) break;
    after = next;
  }
  throw new AppError(503, '订阅历史尚未核对完成，请联系维护者；未新建结算');
}

/** Called inside the tenant write lock; provider reads finish before the database transaction. */
async function saveProviderSubscription(
  stripe: Stripe,
  latest: Stripe.Subscription,
  action: string,
  eventId?: string,
) {
  const userId = currentUserId();
  const current = await subscription();
  if (!current.customer_id) throw new AppError(400, '当前账号未绑定支付客户');
  assertOwner(latest, current.customer_id, userId);
  let ignored = false;
  if (current.subscription_id && current.subscription_id !== latest.id) {
    // A delayed deletion of the old subscription must never downgrade its replacement.
    ignored = terminal(latest.status);
    if (!ignored) {
      const previous = await stripe.subscriptions.retrieve(current.subscription_id);
      assertOwner(previous, current.customer_id, userId);
      if (!terminal(previous.status))
        throw new AppError(409, '已有其他待处理订阅，请联系维护者核对账单');
    }
  }
  const items = latest.items.data;
  const periodEnd = items[0]?.current_period_end;
  const validPeriod =
    typeof periodEnd === 'number' && Number.isFinite(periodEnd) && periodEnd * 1000 > Date.now();
  const active =
    ['active', 'trialing'].includes(latest.status) &&
    items.length === 1 &&
    items[0].price.id === process.env.STRIPE_PRICE_PRO &&
    items[0].quantity === 1 &&
    validPeriod;
  return dbTransaction(async () => {
    if (eventId) {
      const inserted = await query(
        'INSERT INTO webhook_events(id) VALUES($1) ON CONFLICT(id) DO NOTHING RETURNING id',
        [eventId],
      );
      if (!inserted.rows.length) return { received: true, replayed: true };
    }
    if (!ignored)
      await query(
        'UPDATE subscriptions SET plan=$1,status=$2,subscription_id=$3,current_period_end=$4,updated_at=now() WHERE user_id=$5',
        [
          active ? 'pro' : 'free',
          latest.status,
          latest.id,
          validPeriod ? new Date(periodEnd * 1000).toISOString() : null,
          userId,
        ],
      );
    await query('INSERT INTO audit_events(id,user_id,action) VALUES($1,$2,$3)', [
      randomUUID(),
      userId,
      ignored ? `${action}:obsolete` : action,
    ]);
    return { received: true, replayed: false, ignored };
  });
}

/** Recovery for delayed webhooks. Entitlements come only from authenticated provider state. */
export async function reconcileBilling() {
  const stripe = stripeClient();
  const current = await subscription();
  if (!current.customer_id) return { reconciled: false };
  const history = await providerSubscriptions(stripe, current.customer_id, currentUserId());
  let latest =
    history.find((item) => !terminal(item.status)) ??
    history.find((item) => item.id === current.subscription_id);
  if (!latest && current.subscription_id)
    latest = await stripe.subscriptions.retrieve(current.subscription_id);
  if (!latest) return { reconciled: false };
  await saveProviderSubscription(stripe, latest, 'billing:reconcile');
  return { reconciled: true };
}

interface CheckoutAttempt {
  checkout_attempt_id: string | null;
  checkout_started_at: Date | string | null;
  checkout_session_id: string | null;
  checkout_request: Stripe.Checkout.SessionCreateParams | null;
}
function checkoutResult(
  session: Stripe.Checkout.Session,
  customer: string,
  userId: string,
  history: Stripe.Subscription[],
) {
  const providerCustomer =
    typeof session.customer === 'string' ? session.customer : session.customer?.id;
  if (
    providerCustomer !== customer ||
    session.metadata?.productspy_user_id !== userId ||
    session.client_reference_id !== userId ||
    session.mode !== 'subscription'
  )
    throw new AppError(400, '结算页面与当前账号不匹配');
  if (session.status === 'complete') {
    const subscriptionId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    if (history.some((item) => item.id === subscriptionId && terminal(item.status))) return null;
    throw new AppError(409, '结算已完成，请刷新订阅状态或打开账单管理');
  }
  if (session.status === 'expired') return null;
  if (session.status !== 'open' || !session.url)
    throw new AppError(502, '支付服务未返回有效结算页面');
  return { url: session.url };
}
export async function createCheckout() {
  const stripe = stripeClient(),
    userId = currentUserId(),
    current = await subscription();
  if (current.plan === 'pro') throw new AppError(409, '当前已有 Pro 订阅，请使用账单管理');
  let customer = current.customer_id;
  if (!customer) {
    const result = await query<{ email: string }>('SELECT email FROM users WHERE id=$1', [userId]);
    const created = await stripe.customers.create(
      { email: result.rows[0].email, metadata: { productspy_user_id: userId } },
      { idempotencyKey: `productspy:customer:${userId}` },
    );
    customer = created.id;
    await query('UPDATE subscriptions SET customer_id=$1,updated_at=now() WHERE user_id=$2', [
      customer,
      userId,
    ]);
  }
  // The webhook may be delayed. Check the provider before offering a second subscription.
  const history = await providerSubscriptions(stripe, customer, userId);
  if (history.some((item) => !terminal(item.status)))
    throw new AppError(409, '已有待处理订阅，请刷新订阅状态或打开账单管理');
  if (current.subscription_id && !terminal(current.status))
    throw new AppError(409, '已有待处理订阅，请先刷新订阅状态');
  let attempt = (
    await query<CheckoutAttempt>(
      'SELECT checkout_attempt_id,checkout_started_at,checkout_session_id,checkout_request FROM subscriptions WHERE user_id=$1',
      [userId],
    )
  ).rows[0];
  for (let pass = 0; pass < 2; pass++) {
    if (attempt.checkout_session_id) {
      const session = await stripe.checkout.sessions.retrieve(attempt.checkout_session_id);
      const result = checkoutResult(session, customer, userId, history);
      if (result) return result;
      attempt = {
        checkout_attempt_id: null,
        checkout_started_at: null,
        checkout_session_id: null,
        checkout_request: null,
      };
    }
    if (!attempt.checkout_attempt_id) {
      const input: Stripe.Checkout.SessionCreateParams = {
        mode: 'subscription',
        customer,
        line_items: [{ price: process.env.STRIPE_PRICE_PRO!, quantity: 1 }],
        success_url: `${appOrigin()}/billing?checkout=success`,
        cancel_url: `${appOrigin()}/billing?checkout=canceled`,
        client_reference_id: userId,
        metadata: { productspy_user_id: userId },
        subscription_data: { metadata: { productspy_user_id: userId } },
      };
      attempt = {
        checkout_attempt_id: randomUUID(),
        checkout_started_at: new Date(Date.now()).toISOString(),
        checkout_session_id: null,
        checkout_request: input,
      };
      // Commit before the provider POST: a lost response must reuse this exact key and payload.
      await query(
        'UPDATE subscriptions SET checkout_attempt_id=$1,checkout_started_at=$2,checkout_session_id=NULL,checkout_request=$3::jsonb,updated_at=now() WHERE user_id=$4',
        [attempt.checkout_attempt_id, attempt.checkout_started_at, JSON.stringify(input), userId],
      );
    }
    const age = Date.now() - new Date(attempt.checkout_started_at ?? '').getTime();
    // Stripe may prune keys after 24 hours. Never automatically replay an unknown result then.
    if (!Number.isFinite(age) || age < 0 || age >= 23 * 3600_000 || !attempt.checkout_request)
      throw new AppError(409, '上次结算结果仍待核对，请联系维护者；未重新发起结算');
    const session = await stripe.checkout.sessions.create(attempt.checkout_request, {
      idempotencyKey: `productspy:checkout:${attempt.checkout_attempt_id}`,
    });
    await query('UPDATE subscriptions SET checkout_session_id=$1 WHERE user_id=$2', [
      session.id,
      userId,
    ]);
    const result = checkoutResult(session, customer, userId, history);
    if (result) return result;
    attempt.checkout_session_id = session.id;
  }
  throw new AppError(409, '结算页面已过期，请重新打开账单页后重试');
}
export async function createPortal() {
  const stripe = stripeClient(),
    current = await subscription();
  if (!current.customer_id) throw new AppError(409, '当前账号还没有账单记录');
  const session = await stripe.billingPortal.sessions.create({
    customer: current.customer_id,
    return_url: `${appOrigin()}/billing`,
  });
  return { url: session.url };
}
export async function handleStripeWebhook(raw: string, signature: string) {
  const stripe = stripeClient();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, process.env.STRIPE_WEBHOOK_SECRET!, 300);
  } catch {
    throw new AppError(400, 'Webhook 签名无效或时间过期');
  }
  const testKey = /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY!);
  if (event.livemode === testKey) throw new AppError(400, 'Webhook 支付环境与服务端配置不匹配');
  if (
    ![
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ].includes(event.type)
  )
    return { received: true, ignored: true };
  const object = event.data.object as Stripe.Subscription;
  const userId = object.metadata?.productspy_user_id;
  if (!userId || !z.string().uuid().safeParse(userId).success)
    throw new AppError(400, '订阅缺少有效用户归属');
  return withTenant(userId, async () => {
    const prior = await query('SELECT id FROM webhook_events WHERE id=$1', [event.id]);
    if (prior.rows.length) return { received: true, replayed: true };
    // Read current provider state under the tenant lock, so out-of-order delivery cannot grant it.
    const latest = await stripe.subscriptions.retrieve(object.id);
    return saveProviderSubscription(stripe, latest, `stripe:${event.type}`, event.id);
  });
}
