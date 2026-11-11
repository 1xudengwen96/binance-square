import type { Metric } from './hypotheses.ts';

/** Describes the actual score.ts outcome, including its mixed-age counter inputs. */
export const METRIC_DEFINITIONS: Record<Metric, { label: string; unit: string; formula: string; sample: string }> = {
  views24h: { label: '24h 浏览量', unit: '次浏览', formula: '发布后 24h 检查点浏览数（v24h）', sample: '有 24h 浏览读数' },
  growth1h: { label: '首小时增速', unit: '倍', formula: '1h 浏览数 ÷ 20 分钟浏览数', sample: '有 1h 和 20 分钟浏览读数，且 20 分钟浏览数 > 0' },
  engagementPer1k: { label: '每千次浏览互动数', unit: '次/千次浏览', formula: '(最新点赞数 + 最新评论数 + 最新分享数) ÷ 24h 浏览数 × 1000', sample: '24h 浏览数 > 0，且点赞/评论/分享至少一项有读数；其余缺项按 0' },
  qualityPer1k: { label: '每千次浏览互动质量', unit: '加权分/千次浏览', formula: '(最新点赞数 + 3 × 最新评论数 + 4 × 最新分享数) ÷ 24h 浏览数 × 1000', sample: '24h 浏览数 > 0，且点赞/评论/分享至少一项有读数；其余缺项按 0' },
  rebatePer1k: { label: '每千次浏览返佣', unit: 'USDT/千次浏览', formula: '人工日返佣按浏览加权归因到帖的金额 ÷ 24h 浏览数 × 1000（近似）', sample: '24h 浏览数 > 0，且有帖级返佣归因值' },
};

export const MEASUREMENT_SAMPLE = '窗口内已发布且满 24 小时的帖子；实验按已登记臂分组，观察按维度分组；仅计该指标有可用读数的帖子，缺读数不计为 0。median 为逐帖指标的中位数（偶数样本取中间两值平均），n 为参与计算的帖子数；分层明细沿用同一指标与单位。';

export function metricDescription(metric: Metric): string {
  const d = METRIC_DEFINITIONS[metric];
  return `${metric}（${d.label}；单位：${d.unit}；公式：${d.formula}；有效样本：${d.sample}）`;
}

export function formatMetric(metric: Metric, value: number | null): string {
  return value == null ? '—' : metric === 'views24h' ? Math.round(value).toLocaleString('en-US') : value.toFixed(2);
}
