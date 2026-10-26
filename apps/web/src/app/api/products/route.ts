import { draftSchema } from '@productspy/shared';
import { createHash, randomUUID } from 'node:crypto';
import { saasEnabled, currentUserId } from '../../../lib/saas/context';
import { dbTransaction, query } from '../../../lib/saas/database';
import { AppError } from '../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../lib/server/http';
import { getProductRepository } from '../../../lib/server/product-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return withApiRequest(request, () => getProductRepository().list());
}

export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      const body = await readJsonBody(request);
      const parsed = draftSchema.safeParse(body);
      if (!parsed.success)
        throw new AppError(400, '商品信息不完整或格式无效，请重新采集 Amazon 商品页面');
      if (saasEnabled())
        return dbTransaction(async () => {
          const id = request.headers.get('idempotency-key') ?? randomUUID();
          if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new AppError(400, '采集请求编号无效');
          const fingerprint = createHash('sha256')
            .update(JSON.stringify(parsed.data))
            .digest('hex');
          const owner = currentUserId(),
            repository = getProductRepository();
          const prior = await query<{ payload_hash: string; product_id: string }>(
            'SELECT payload_hash,product_id FROM capture_events WHERE user_id=$1 AND id=$2',
            [owner, id],
          );
          if (prior.rows[0]) {
            if (prior.rows[0].payload_hash !== fingerprint)
              throw new AppError(409, '此采集请求编号已用于其他数据');
            const product = await repository.get(prior.rows[0].product_id);
            if (!product) throw new AppError(409, '此采集结果已删除，请明确重新采集');
            return product;
          }
          const product = await repository.upsert(parsed.data);
          await query(
            'INSERT INTO capture_events(user_id,id,payload_hash,product_id) VALUES($1,$2,$3,$4)',
            [owner, id, fingerprint, product.id],
          );
          return product;
        });
      return getProductRepository().upsert(parsed.data);
    },
    { write: true },
  );
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'POST']);
}
