import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { binance } from '../collectors/binance.ts';
import { renderCardPng, renderKlinePng } from './kline.ts';

/**
 * Build the chart that goes with a post.
 *
 * The footer chips are passed in explicitly rather than sniffed out of a generic
 * record, so a chart can never display a number the copy did not also have.
 */

export interface ChartSubject {
  /** Base asset, without the USDT suffix. */
  symbol: string;
  chg24h?: number | null;
  volMultiple?: number | null;
  funding?: number | null;
  oiChangePct?: number | null;
  longRatio?: number | null;
}

export interface BuiltChart {
  path: string;
  /** Feed-card cover drawn from the same candles. Goes first when present. */
  card?: string;
  chips: string[];
  changePct: number;
}

/**
 * What the card needs beyond the candles.
 *
 * The annotation is the post's own first sentence: the copy has already been through the fact
 * check and the voice gates, so a cover that quotes it cannot claim anything the body does not.
 * A hand-written or model-written line here would be a number with no ledger behind it.
 */
export interface ChartCard {
  column?: string;
  annotation?: string | null;
  watermark?: string;
}

/**
 * The first line of the post that is actually a sentence. Emoji are stripped — the rasteriser
 * has no glyph for them and prints tofu boxes — and hashtag/cashtag lines are skipped, because
 * a tag is not a claim worth printing large.
 */
export function cardAnnotation(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('$')) continue;
    return line;
  }
  return null;
}

const BARS = 96;

export type Interval = '1h' | '4h' | '1d';

function signed(v: number, digits: number, suffix = '%'): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}${suffix}`;
}

export async function buildChartFor(s: ChartSubject, outDir = 'data/charts', interval: Interval = '1h', card?: ChartCard): Promise<BuiltChart | null> {
  const pair = `${s.symbol.toUpperCase()}USDT`;
  let fromFutures = true;
  let k = await binance.futuresKlines(pair, interval, BARS + 2).catch(() => null);
  if (!k || k.length < 4) {
    k = await binance.klines(pair, interval as '1h' | '4h' | '1d', BARS + 2).catch(() => null);
    fromFutures = false;
  }
  if (!k || k.length < 4) return null;

  // Drop the still-forming candle, then keep exactly the bars the renderer draws, so the header
  // percentage is measured over the window the reader can see.
  const closed = k.slice(0, -1).slice(-BARS);
  const first = Number(closed[0]![4]);
  const last = Number(closed[closed.length - 1]![4]);
  if (!first) return null;
  const changePct = ((last - first) / first) * 100;

  // The header number covers the whole drawn window; the «24 小时» chip must be a real 24h figure
  // or be left out. Falling back to the window change under a 24h label showed two different
  // percentages for the same coin on one image.
  const span = closed.length * (interval === '1h' ? 1 : interval === '4h' ? 4 : 24);
  const changeLabel = span >= 48 && span % 24 === 0 ? `近${span / 24}天` : `近${span}小时`;

  const chips = [
    s.chg24h != null ? `24 小时涨跌 ${signed(s.chg24h, 2)}` : null,
    s.funding != null ? `资金费率 ${(s.funding * 100).toFixed(3)}%` : null,
    s.oiChangePct != null ? `持仓量 24h ${signed(s.oiChangePct, 1)}` : null,
    s.longRatio != null ? `多空账户比 ${s.longRatio.toFixed(2)}` : null,
    s.volMultiple != null ? `1 小时成交 ${s.volMultiple.toFixed(1)} 倍` : null,
  ].filter(Boolean) as string[];

  const png = await renderKlinePng(closed, {
    title: `${pair} 永续 · ${interval.toUpperCase()}`,
    subtitle: '币安合约',
    lastPrice: last,
    changePct,
    changeLabel,
    stats: { chips },
  });

  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${s.symbol.toUpperCase()}-${interval}-${Date.now()}.png`);
  writeFileSync(path, png);

  // The card is the cover, the candles are the evidence: both come from the same `closed`
  // window, so the big sentence and the bars cannot disagree about which hours they cover.
  let cardPath: string | undefined;
  const annotation = card?.annotation?.trim();
  if (card && annotation) {
    const cardPng = await renderCardPng(closed, {
      column: card.column ?? '行情异动',
      title: s.symbol.toUpperCase(),
      market: fromFutures ? '永续' : '现货',
      lastPrice: last,
      // The badge says 24 小时, so it must carry the audited 24h figure when we have one;
      // the window change under a 24h label is exactly the confusion the chips rule forbids.
      changePct: s.chg24h ?? changePct,
      changeLabel: s.chg24h != null ? '24 小时' : changeLabel,
      annotation,
      source: fromFutures ? '币安合约行情' : '币安现货行情',
      watermark: card.watermark,
      bars: 18,
    }).catch(() => null);
    if (cardPng) {
      cardPath = join(outDir, `${s.symbol.toUpperCase()}-card-${Date.now()}.png`);
      writeFileSync(cardPath, cardPng);
    }
  }
  return { path, card: cardPath, chips, changePct };
}
