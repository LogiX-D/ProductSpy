import {
  exportAnalysesMarkdown,
  exportProductsCsv,
  serializeLibraryBackup,
  type LibraryExportFile,
} from '@productspy/shared';
import { z } from 'zod';
import { AppError } from '../../../../lib/server/errors';
import { preflight, readJsonBody, withApiRequest } from '../../../../lib/server/http';
import { getProductRepository } from '../../../../lib/server/product-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const exportRequestSchema = z
  .object({
    format: z.enum(['json', 'csv', 'markdown']).default('json'),
    ids: z.array(z.string().min(1).max(100)).max(2000).default([]),
  })
  .strict();

async function exportFile(input: unknown): Promise<LibraryExportFile> {
  const parsed = exportRequestSchema.safeParse(input);
  if (!parsed.success) throw new AppError(400, '导出格式或所选商品编号无效，单次最多 2000 件');
  const { format, ids } = parsed.data;
  if (new Set(ids).size !== ids.length) throw new AppError(400, '所选商品编号不能重复');
  const snapshot = await getProductRepository().librarySnapshot();
  const selected = new Set(ids);
  const products = ids.length
    ? snapshot.products.filter((item) => selected.has(item.id))
    : snapshot.products;
  if (ids.length && products.length !== ids.length)
    throw new AppError(409, '部分所选商品已删除，请刷新后重新导出；不会静默遗漏商品');
  const date = new Date().toISOString().slice(0, 10);
  const count = products.length;
  if (format === 'csv')
    return {
      filename: `ProductSpy-products-${date}.csv`,
      mimeType: 'text/csv;charset=utf-8',
      content: exportProductsCsv(products),
      count,
    };
  if (format === 'markdown')
    return {
      filename: `ProductSpy-analysis-${date}.md`,
      mimeType: 'text/markdown;charset=utf-8',
      content: exportAnalysesMarkdown(products),
      count,
    };
  const referencedGroups = new Set(products.flatMap((item) => item.groupIds ?? []));
  const referencedTags = new Set(products.flatMap((item) => item.tagIds ?? []));
  try {
    return {
      filename: `ProductSpy-${ids.length ? 'products' : 'backup'}-${date}.json`,
      mimeType: 'application/json;charset=utf-8',
      content: serializeLibraryBackup({
        products,
        groups: ids.length
          ? snapshot.groups.filter((item) => referencedGroups.has(item.id))
          : snapshot.groups,
        tags: ids.length
          ? snapshot.tags.filter((item) => referencedTags.has(item.id))
          : snapshot.tags,
      }),
      count,
    };
  } catch (error) {
    throw new AppError(
      400,
      `${error instanceof Error ? error.message : '备份无法安全导入'}。请缩小选择范围或检查原始资料；没有删除任何商品。`,
    );
  }
}

export function GET(request: Request): Promise<Response> {
  return withApiRequest(
    request,
    () => {
      const url = new URL(request.url);
      return exportFile({
        format: url.searchParams.get('format') ?? 'json',
        ids: url.searchParams.getAll('id'),
      });
    },
    { webOnly: true },
  );
}

export function POST(request: Request): Promise<Response> {
  return withApiRequest(request, async () => exportFile(await readJsonBody(request)), {
    write: true,
    webOnly: true,
  });
}

export function OPTIONS(request: Request): Promise<Response> {
  return preflight(request, ['GET', 'POST'], { webOnly: true });
}
