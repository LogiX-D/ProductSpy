import JSZip from 'jszip';
import {
  CONTENT_FIELDS,
  contentFieldLabels,
  contentExportFilename,
  currentContentVersion,
  exportContentMarkdown,
  exportContentTxt,
  exportContentJson,
  type ContentPlan,
  type ContentField,
} from '@productspy/shared';
import { downloadLibraryFile } from '../lib/library-api';

export async function buildContentZip(
  plan: ContentPlan,
  fields: readonly ContentField[] = CONTENT_FIELDS,
  versionId?: string,
): Promise<Uint8Array> {
  const version = versionId
    ? plan.versions.find((item) => item.id === versionId)
    : currentContentVersion(plan);
  if (!version) throw new Error('请先生成或保存内容后再导出。');
  const zip = new JSZip();
  zip.file(contentExportFilename(plan, 'md'), exportContentMarkdown(plan, fields, version.id));
  zip.file(contentExportFilename(plan, 'json'), exportContentJson(plan, fields, version.id));
  for (const field of fields)
    zip.file(
      `${field}-${plan.productSnapshot.sourceId}.txt`,
      `${contentFieldLabels[field]}\n\n${version.output[field].join('\n\n')}\n\n内容版本：${version.id}\n商品来源：${plan.productSnapshot.url}\n历史采集：${plan.productSnapshot.updatedAt}\n`,
    );
  zip.file(
    'README.txt',
    'ProductSpy 营销内容包\n所有内容均为可编辑创意草稿，发布前需人工核查。\n商品信息来自历史 Amazon 页面采集，规格和卖点属于商家宣称。\n未采集评论正文时不得声称分析评论；未上传、下载或复制图片、视频或受限媒体。\nMock 内容不代表真实 AI 品质。时长仅是文本估算，不是实际拍摄时长。\n详细商品、模板、生成参数和事实来源见 JSON / Markdown 文件。',
  );
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

export async function downloadContent(
  plan: ContentPlan,
  format: 'markdown' | 'txt' | 'json' | 'zip',
  fields: readonly ContentField[] = CONTENT_FIELDS,
  versionId?: string,
): Promise<void> {
  const extension = format === 'markdown' ? 'md' : format;
  const version = versionId
    ? plan.versions.find((item) => item.id === versionId)
    : currentContentVersion(plan);
  if (!version) throw new Error('请先生成或保存内容后再导出。');
  if (format !== 'zip') {
    const content =
      format === 'markdown'
        ? exportContentMarkdown(plan, fields, version.id)
        : format === 'txt'
          ? exportContentTxt(plan, fields, version.id)
          : exportContentJson(plan, fields, version.id);
    downloadLibraryFile({
      filename: contentExportFilename(plan, extension),
      mimeType: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8',
      content,
      count: 1,
    });
    return;
  }
  const bytes = await buildContentZip(plan, fields, version.id);
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = contentExportFilename(plan, 'zip');
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
