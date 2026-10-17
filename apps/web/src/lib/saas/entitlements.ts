import { query } from './database';
import { currentUserId } from './context';
import { AppError } from '../server/errors';
import { getProductRepository } from '../server/product-repository';

export const PLAN_LIMITS = {
  free: { products: 50, ai: 10 },
  pro: { products: 5000, ai: 500 },
} as const;
export async function subscription() {
  const { rows } = await query<{
    plan: string;
    status: string;
    customer_id: string | null;
    subscription_id: string | null;
    current_period_end: string | Date | null;
  }>(
    'SELECT plan,status,customer_id,subscription_id,current_period_end FROM subscriptions WHERE user_id=$1',
    [currentUserId()],
  );
  const row = rows[0];
  const active =
    row &&
    ['active', 'trialing'].includes(row.status) &&
    (!row.current_period_end || new Date(row.current_period_end).getTime() > Date.now());
  return {
    ...row,
    plan: row?.plan === 'pro' && active ? ('pro' as const) : ('free' as const),
    status: row?.status ?? 'active',
  };
}
export async function accountSummary(user: {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}) {
  const current = await subscription();
  const { rows } = await query<{ count: string | number }>(
    'SELECT count(*) AS count FROM usage_events WHERE user_id=$1 AND kind=$2 AND period=$3',
    [currentUserId(), 'ai', new Date().toISOString().slice(0, 7)],
  );
  return {
    user,
    subscription: { plan: current.plan, status: current.status },
    usage: { products: (await getProductRepository().list()).length, ai: Number(rows[0].count) },
    limits: PLAN_LIMITS[current.plan],
    billingEnabled: Boolean(
      process.env.STRIPE_SECRET_KEY &&
      process.env.STRIPE_PRICE_PRO &&
      process.env.STRIPE_WEBHOOK_SECRET,
    ),
  };
}
export async function consumeAIAllowance(requestId: string): Promise<void> {
  const userId = currentUserId();
  const current = await subscription();
  const period = new Date().toISOString().slice(0, 7);
  const prior = await query('SELECT id FROM usage_events WHERE user_id=$1 AND id=$2', [
    userId,
    requestId,
  ]);
  if (prior.rows.length) return;
  const { rows } = await query<{ count: string | number }>(
    'SELECT count(*) AS count FROM usage_events WHERE user_id=$1 AND kind=$2 AND period=$3',
    [userId, 'ai', period],
  );
  if (Number(rows[0].count) >= PLAN_LIMITS[current.plan].ai)
    throw new AppError(429, '已达到当前套餐本月 AI 次数上限；失败或中断请求也计入用量');
  await query('INSERT INTO usage_events(user_id,id,kind,period) VALUES($1,$2,$3,$4)', [
    userId,
    requestId,
    'ai',
    period,
  ]);
}
export async function assertProductAllowance(existing: boolean): Promise<void> {
  if (existing) return;
  const current = await subscription();
  if ((await getProductRepository().list()).length >= PLAN_LIMITS[current.plan].products)
    throw new AppError(403, '已达到当前套餐商品数量上限，请整理商品或升级套餐');
}
export async function assertProductCount(nextCount: number, previousCount: number): Promise<void> {
  if (nextCount <= previousCount) return;
  const current = await subscription();
  if (nextCount > PLAN_LIMITS[current.plan].products)
    throw new AppError(403, '导入或采集后的商品数量超出当前套餐上限，请先减少商品或升级套餐');
}
