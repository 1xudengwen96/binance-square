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

export type Interval = '1h' | '4h' | '1d';

function signed(v: number, digits: number, suffix = '%'): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}${suffix}`;
}

export async function buildChartFor(s: ChartSubject, outDir = 'data/charts', interval: Interval = '1h'): Promise<BuiltChart | null> {
  const pair = `${s.symbol.toUpperCase()}USDT`;
  let k = await binance.futuresKlines(pair, interval, 74).catch(() => null);
  if (!k || k.length < 4) k = await binance.klines(pair, interval as '1h' | '4h' | '1d', 74).catch(() => null);
  if (!k || k.length < 4) return null;

  const closed = k.slice(0, -1); // drop the still-forming candle
  const first = Number(closed[0]![4]);
  const last = Number(closed[closed.length - 1]![4]);
  if (!first) return null;
  const changePct = ((last - first) / first) * 100;

  const chips = [
    `24h ${s.chg24h != null ? signed(s.chg24h, 2) : signed(changePct, 2)}`,
    s.funding != null ? `Funding ${(s.funding * 100).toFixed(3)}%` : null,
    s.oiChangePct != null ? `OI 24h ${signed(s.oiChangePct, 1)}` : null,
    s.longRatio != null ? `L/S ${s.longRatio.toFixed(2)}` : null,
    s.volMultiple != null ? `1h vol x${s.volMultiple.toFixed(1)}` : null,
  ].filter(Boolean) as string[];

  const png = await renderKlinePng(closed, {
    title: `${pair} Perp · ${interval.toUpperCase()}`,
    subtitle: 'Binance Futures',
    lastPrice: last,
    changePct,
    stats: { chips },
  });

  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${s.symbol.toUpperCase()}-${interval}-${Date.now()}.png`);
  writeFileSync(path, png);
  return { path, chips, changePct };
}
