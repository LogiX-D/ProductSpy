import type { AnalysisMetadata } from '@productspy/shared';
import { analysisProvenance } from './analysis-history';

export function AnalysisEvidence({ metadata }: { metadata?: AnalysisMetadata }) {
  return (
    <details className="analysis-evidence">
      <summary>
        <strong>事实依据与 AI 推断</strong>
        <span>未分析真实评论正文</span>
      </summary>
      <p className="analysis-field-hint">{analysisProvenance(metadata)}</p>
      {metadata ? (
        <div className="analysis-evidence-grid">
          {(
            [
              { key: 'facts', title: '商品页面事实' },
              { key: 'inferences', title: 'AI 推断与建议' },
              { key: 'unknowns', title: '未知与待验证' },
            ] as const
          ).map(({ key, title }) => (
            <div key={key}>
              <h3>{title}</h3>
              <ul>
                {metadata.evidence[key].map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p>
          此旧版结果没有独立事实清单。价格、功能、材质和效果需回到商品页面核对；受众、痛点和营销方向为推断。
        </p>
      )}
      <p className="analysis-fact-note">
        评分与评论数量只是商品页面汇总数据。没有采集真实评论正文，不能据此声称已经分析消费者评论。
      </p>
    </details>
  );
}
