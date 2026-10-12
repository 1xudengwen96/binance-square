import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { binance } from '../collectors/binance.ts';
import { renderKlinePng } from './kline.ts';

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
  chips: string[];
  changePct: number;
}

const BARS = 72;

export type Interval = '1h' | '4h' | '1d';

function signed(v: number, digits: number, suffix = '%'): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}${suffix}`;
}

export async function buildChartFor(s: ChartSubject, outDir = 'data/charts', interval: Interval = '1h'): Promise<BuiltChart | null> {
  const pair = `${s.symbol.toUpperCase()}USDT`;
  let k = await binance.futuresKlines(pair, interval, 74).catch(() => null);
  if (!k || k.length < 4) k = await binance.klines(pair, interval as '1h' | '4h' | '1d', 74).catch(() => null);
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
  return { path, chips, changePct };
}
