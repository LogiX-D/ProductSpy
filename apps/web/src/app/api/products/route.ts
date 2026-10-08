import { draftSchema } from '@productspy/shared';
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
      return getProductRepository().upsert(parsed.data);
    },
    { write: true },
  );
}

export function OPTIONS(request: Request): Response {
  return preflight(request, ['GET', 'POST']);
}
