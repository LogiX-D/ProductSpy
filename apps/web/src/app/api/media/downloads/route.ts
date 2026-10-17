import { z } from 'zod';
import { readJsonBody, withApiRequest } from '../../../../lib/server/http';
import { getProductRepository } from '../../../../lib/server/product-repository';
import {
  cancelMediaDownload,
  cancelMediaDirectoryPicker,
  downloadMediaAsset,
  mediaDirectoryAvailable,
  openMediaLocation,
  prepareMediaDownload,
} from '../../../../lib/server/media-downloads';
import { AppError } from '../../../../lib/server/errors';
import { saasEnabled } from '../../../../lib/saas/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('cancel-picker') }).strict(),
  z.object({ action: z.literal('prepare'), productId: z.string().min(1).max(100) }).strict(),
  z
    .object({
      action: z.literal('download'),
      jobId: z.string().regex(/^[a-f0-9]{48}$/),
      assetId: z.string().regex(/^(image|video)-\d+$/),
      url: z.string().max(4096).optional(),
    })
    .strict(),
  z.object({ action: z.literal('cancel'), jobId: z.string().regex(/^[a-f0-9]{48}$/) }).strict(),
  z
    .object({
      action: z.literal('open'),
      jobId: z.string().regex(/^[a-f0-9]{48}$/),
      assetId: z
        .string()
        .regex(/^(image|video)-\d+$/)
        .optional(),
    })
    .strict(),
]);
export function GET(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    () => ({ nativeDirectoryPicker: !saasEnabled() && mediaDirectoryAvailable() }),
    {
      webOnly: true,
    },
  );
}
export function POST(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    async () => {
      if (saasEnabled())
        throw new AppError(410, '在线工作台请使用浏览器下载；服务器不提供本机目录操作');
      const parsed = requestSchema.safeParse(await readJsonBody(request, 16384));
      if (!parsed.success) throw new AppError(400, '素材下载请求无效；目录只能由本机选择窗口指定');
      const input = parsed.data;
      if (input.action === 'cancel-picker') {
        cancelMediaDirectoryPicker();
        return { cancelled: true };
      }
      if (input.action === 'prepare') {
        const product = await getProductRepository().get(input.productId);
        if (!product) throw new AppError(404, '商品已删除，请刷新商品库');
        const job = await prepareMediaDownload(product, request.signal);
        return { job: job ?? null };
      }
      if (input.action === 'download')
        return { job: await downloadMediaAsset(input.jobId, input.assetId, input.url) };
      if (input.action === 'cancel') return { job: cancelMediaDownload(input.jobId) };
      await openMediaLocation(input.jobId, input.assetId);
      return { opened: true };
    },
    { write: true, webOnly: true },
  );
}
