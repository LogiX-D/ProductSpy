import {
  generationResultSchema,
  type AIGenerationResult,
  type AnalysisOptions,
  type Product,
} from '@productspy/shared';

export interface QualityCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/** Repeatable guardrails, not a substitute for human review or a real-model quality score. */
export function evaluateGeneration(
  product: Product,
  options: AnalysisOptions,
  result: AIGenerationResult,
  unsupportedClaims: string[],
): QualityCheck[] {
  const text = JSON.stringify(result.analysis);
  const rendered = Object.values(result.analysis).flat().join('\n');
  const missing = unsupportedClaims.filter((claim) =>
    text.toLowerCase().includes(claim.toLowerCase()),
  );
  const durationRanges = [...result.analysis.shortVideoScript.matchAll(/(\d+)[–-](\d+)s/g)].map(
    (range) => [Number(range[1]), Number(range[2])],
  );
  const language =
    options.language === 'zh-CN'
      ? /[\u4e00-\u9fff]/
      : options.language === 'ja'
        ? /[\u3040-\u30ff]/
        : /\b(?:page|product|scene|captured|check|mock)\b/i;
  const claimsRetained = product.bulletPoints.every((claim) =>
    result.evidence.facts.some((fact) => fact.includes(claim)),
  );
  return [
    {
      name: '完整结构及五段脚本',
      passed: generationResultSchema.safeParse(result).success,
      detail: '12 个分析字段、至少 5 个开场、证据分类均经过共享 schema。',
    },
    {
      name: '页面卖点可追溯',
      passed: claimsRetained,
      detail: '合成样本每条卖点仍能在页面事实区找到原文，不代表商家宣称已实测。',
    },
    {
      name: '不冒充评论分析',
      passed:
        result.evidence.reviewTextAnalyzed === false &&
        result.evidence.unknowns.length > 0 &&
        !/(?:用户评论表明|根据用户评论分析|customers report that|reviews prove that|レビュー分析の結果)/i.test(
          rendered,
        ),
      detail: '评论数量不等于评论正文；扫描仅覆盖已定义的危险表达。',
    },
    {
      name: '未虚构测试哨兵参数',
      passed: missing.length === 0,
      detail: missing.length
        ? `发现样本未提供的声明：${missing.join(', ')}`
        : '仅检查每个样本事先定义的三个缺失参数；无法证明无其他幻觉。',
    },
    {
      name: '选定语言的正文',
      passed:
        language.test(result.analysis.summary) && language.test(result.analysis.shortVideoScript),
      detail: '基础字符/词汇检查；产品原文和脚本五段标签允许保留英文。',
    },
    {
      name: '脚本时长连续可执行',
      passed:
        durationRanges.length === 5 &&
        durationRanges[0]?.[0] === 0 &&
        durationRanges.at(-1)?.[1] === options.duration &&
        durationRanges.every(
          ([start, end], index) =>
            end > start && (!index || start === durationRanges[index - 1][1]),
        ),
      detail: '五段时间区间连续且覆盖所选秒数；真实朗读节奏需人工验收。',
    },
    {
      name: '保留自定义要求',
      passed: rendered.includes('QA_REQUIREMENT'),
      detail: 'Mock 保留要求供核对；不宣称演示模板具有真实模型指令理解能力。',
    },
  ];
}
