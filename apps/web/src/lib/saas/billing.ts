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
export async function createCheckout() {
  const stripe = stripeClient(),
    userId = currentUserId(),
    current = await subscription();
  if (current.plan === 'pro') throw new AppError(409, '当前已有 Pro 订阅，请使用账单管理');
  if (current.subscription_id && current.status !== 'canceled')
    throw new AppError(409, '已有待处理订阅，请先在账单管理中处理');
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
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      customer,
      line_items: [{ price: process.env.STRIPE_PRICE_PRO!, quantity: 1 }],
      success_url: `${appOrigin()}/billing?checkout=success`,
      cancel_url: `${appOrigin()}/billing?checkout=canceled`,
      client_reference_id: userId,
      metadata: { productspy_user_id: userId },
      subscription_data: { metadata: { productspy_user_id: userId } },
    },
    { idempotencyKey: `productspy:checkout:${userId}:${Math.floor(Date.now() / 3600_000)}` },
  );
  if (!session.url) throw new AppError(502, '支付服务未返回结算页面');
  return { url: session.url };
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
  // Read current provider state: delivery order cannot grant an older subscription state.
  return withTenant(userId, async () => {
    const latest = await stripe.subscriptions.retrieve(object.id);
    if (latest.metadata.productspy_user_id !== userId)
      throw new AppError(400, '订阅用户归属不一致');
    return dbTransaction(async () => {
      const current = await subscription();
      const customer = typeof latest.customer === 'string' ? latest.customer : latest.customer.id;
      if (!current.customer_id || current.customer_id !== customer)
        throw new AppError(400, '订阅客户与当前账号不匹配');
      if (
        current.subscription_id &&
        current.subscription_id !== latest.id &&
        !(current.status === 'canceled' && ['active', 'trialing'].includes(latest.status))
      )
        throw new AppError(409, '订阅编号与账号绑定不一致');
      const inserted = await query(
        'INSERT INTO webhook_events(id) VALUES($1) ON CONFLICT(id) DO NOTHING RETURNING id',
        [event.id],
      );
      if (!inserted.rows.length) return { received: true, replayed: true };
      const items = latest.items.data;
      const validPrice =
        items.length === 1 &&
        items[0].price.id === process.env.STRIPE_PRICE_PRO &&
        items[0].quantity === 1;
      const active = ['active', 'trialing'].includes(latest.status) && validPrice;
      const periodEnd = items[0]?.current_period_end;
      await query(
        'UPDATE subscriptions SET plan=$1,status=$2,subscription_id=$3,current_period_end=$4,updated_at=now() WHERE user_id=$5',
        [
          active ? 'pro' : 'free',
          latest.status,
          latest.id,
          periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
          userId,
        ],
      );
      await query('INSERT INTO audit_events(id,user_id,action) VALUES($1,$2,$3)', [
        randomUUID(),
        userId,
        `stripe:${event.type}`,
      ]);
      return { received: true, replayed: false };
    });
  });
}
