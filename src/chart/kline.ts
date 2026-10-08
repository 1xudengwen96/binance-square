import sharp from 'sharp';
import type { Kline } from '../collectors/binance.ts';
import { formatPrice } from '../engine/filters.ts';

/**
 * Server-side candlestick chart.
 *
 * Square's write API accepts image URLs only, so the chart has to be rasterised
 * here and uploaded through the presigned flow. Labels stay ASCII because the
 * bundled rasteriser has no guarantee of a CJK font on the host.
 */

const UP = '#0ecb81';
const DOWN = '#f6465d';
const BG = '#0b0e11';
const PANEL = '#11161b';
const GRID = '#1e2630';
const TEXT = '#e6e9ef';
const DIM = '#7c8798';
const MA_FAST = '#f0b90b';
const MA_SLOW = '#2d9cf0';

export interface ChartStats {
  /** Right-hand footer chips, e.g. ["Funding -0.006%", "OI 24h -0.9%"]. */
  chips: string[];
}

export interface ChartOptions {
  width?: number;
  height?: number;
  bars?: number;
  title: string;
  subtitle?: string;
  lastPrice: number;
  changePct: number;
  stats?: ChartStats;
}

function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] as number;
    if (i >= period) sum -= values[i - period] as number;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** HH:MM in UTC+8, matching how the posting schedule is expressed. */
function barTime(openMs: number): string {
  const d = new Date(openMs + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function renderKlineSvg(klines: Kline[], opts: ChartOptions): string {
  const W = opts.width ?? 1200;
  const H = opts.height ?? 760;
  const PAD_L = 14;
  const PAD_R = 92;
  const PAD_T = 74;
  const FOOTER = 62;
  const TIMEBAND = 30;
  const VOL_H = 54;
  // Bands, top to bottom: price, volume, time labels, stat chips.
  const volBottom = H - FOOTER - TIMEBAND;
  const volTop = volBottom - VOL_H;
  const priceBottom = volTop - 12;
  const plotW = W - PAD_L - PAD_R;

  const rows = klines.slice(-(opts.bars ?? 72)).map(k => ({
    t: k[0],
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[7]),
  }));
  if (rows.length < 3) throw new Error('not enough candles to draw a chart');

  const closes = rows.map(r => r.c);
  const maFast = sma(closes, 7);
  const maSlow = sma(closes, 25);

  let lo = Math.min(...rows.map(r => r.l));
  let hi = Math.max(...rows.map(r => r.h));
  for (const series of [maFast, maSlow]) {
    for (const v of series) {
      if (v === null) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const pad = (hi - lo) * 0.08 || hi * 0.01;
  lo -= pad;
  hi += pad;

  const n = rows.length;
  const step = plotW / n;
  const bodyW = Math.max(2, Math.min(18, step * 0.66));
  const x = (i: number) => PAD_L + step * (i + 0.5);
  const y = (p: number) => PAD_T + ((hi - p) / (hi - lo)) * (priceBottom - PAD_T);
  const maxVol = Math.max(...rows.map(r => r.v)) || 1;
  const vy = (v: number) => volBottom - (v / maxVol) * (volBottom - volTop);

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans, Arial, sans-serif">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);
  parts.push(`<rect x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${priceBottom - PAD_T}" fill="${PANEL}"/>`);

  // horizontal price grid + right axis labels
  for (let g = 0; g <= 4; g++) {
    const p = lo + ((hi - lo) * g) / 4;
    const yy = y(p);
    parts.push(`<line x1="${PAD_L}" y1="${yy.toFixed(1)}" x2="${PAD_L + plotW}" y2="${yy.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`);
    parts.push(`<text x="${PAD_L + plotW + 10}" y="${(yy + 4).toFixed(1)}" fill="${DIM}" font-size="15">${esc(formatPrice(p))}</text>`);
  }

  // time axis, a label every ~12 bars; the first slot is skipped so a centred
  // label cannot hang off the left edge.
  const every = Math.max(1, Math.round(n / 6));
  for (let i = every; i < n; i += every) {
    parts.push(`<line x1="${x(i).toFixed(1)}" y1="${PAD_T}" x2="${x(i).toFixed(1)}" y2="${volBottom}" stroke="${GRID}" stroke-width="1"/>`);
    parts.push(`<text x="${x(i).toFixed(1)}" y="${(H - FOOTER - 8).toFixed(1)}" fill="${DIM}" font-size="13" text-anchor="middle">${esc(barTime(rows[i]!.t))}</text>`);
  }

  // volume
  for (let i = 0; i < n; i++) {
    const r = rows[i]!;
    const col = r.c >= r.o ? UP : DOWN;
    parts.push(`<rect x="${(x(i) - bodyW / 2).toFixed(1)}" y="${vy(r.v).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(1, volBottom - vy(r.v)).toFixed(1)}" fill="${col}" opacity="0.42"/>`);
  }

  // candles
  for (let i = 0; i < n; i++) {
    const r = rows[i]!;
    const up = r.c >= r.o;
    const col = up ? UP : DOWN;
    const cx = x(i);
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${y(r.h).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(r.l).toFixed(1)}" stroke="${col}" stroke-width="1.3"/>`);
    const top = y(Math.max(r.o, r.c));
    const bot = y(Math.min(r.o, r.c));
    parts.push(`<rect x="${(cx - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(1.2, bot - top).toFixed(1)}" fill="${col}"/>`);
  }

  // moving averages
  const path = (series: (number | null)[]): string => {
    let d = '';
    let open = false;
    series.forEach((v, i) => {
      if (v === null) {
        open = false;
        return;
      }
      d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      open = true;
    });
    return d.trim();
  };
  const dFast = path(maFast);
  const dSlow = path(maSlow);
  if (dFast) parts.push(`<path d="${dFast}" fill="none" stroke="${MA_FAST}" stroke-width="2"/>`);
  if (dSlow) parts.push(`<path d="${dSlow}" fill="none" stroke="${MA_SLOW}" stroke-width="2"/>`);

  // last price marker
  const last = rows[n - 1]!;
  const ly = y(last.c);
  const lastCol = last.c >= last.o ? UP : DOWN;
  parts.push(`<line x1="${PAD_L}" y1="${ly.toFixed(1)}" x2="${PAD_L + plotW}" y2="${ly.toFixed(1)}" stroke="${lastCol}" stroke-width="1" stroke-dasharray="5 4"/>`);
  parts.push(`<rect x="${PAD_L + plotW + 2}" y="${(ly - 13).toFixed(1)}" width="${PAD_R - 8}" height="26" rx="4" fill="${lastCol}"/>`);
  parts.push(`<text x="${PAD_L + plotW + 10}" y="${(ly + 5).toFixed(1)}" fill="#0b0e11" font-size="15" font-weight="bold">${esc(formatPrice(last.c))}</text>`);

  // header
  const chg = opts.changePct;
  const chgCol = chg >= 0 ? UP : DOWN;
  parts.push(`<text x="${PAD_L + 4}" y="34" fill="${TEXT}" font-size="26" font-weight="bold">${esc(opts.title)}</text>`);
  parts.push(
    `<text x="${PAD_L + 4 + String(opts.title).length * 15 + 14}" y="34" fill="${chgCol}" font-size="22" font-weight="bold">${esc(
      `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`,
    )}</text>`,
  );
  if (opts.subtitle) parts.push(`<text x="${PAD_L + 4}" y="58" fill="${DIM}" font-size="15">${esc(opts.subtitle)}</text>`);

  // legend
  parts.push(`<text x="${W - PAD_R - 300}" y="34" fill="${MA_FAST}" font-size="15">MA7</text>`);
  parts.push(`<text x="${W - PAD_R - 250}" y="34" fill="${MA_SLOW}" font-size="15">MA25</text>`);
  parts.push(`<text x="${W - PAD_R - 190}" y="34" fill="${DIM}" font-size="15">VOL</text>`);

  // footer stat chips
  (opts.stats?.chips ?? []).slice(0, 5).forEach((c, i) => {
    const cx = PAD_L + 4 + i * 226;
    parts.push(`<rect x="${cx}" y="${H - FOOTER + 8}" width="214" height="34" rx="6" fill="${PANEL}" stroke="${GRID}"/>`);
    parts.push(`<text x="${cx + 12}" y="${H - FOOTER + 31}" fill="${DIM}" font-size="15">${esc(c)}</text>`);
  });

  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * For SVG input, sharp's raster size is driven by `density`: 96 is 4/3 of the
 * SVG's own pixel size, so the chart lands crisp without a resize step.
 */
export async function renderKlinePng(klines: Kline[], opts: ChartOptions): Promise<Buffer> {
  const svg = renderKlineSvg(klines, opts);
  return sharp(Buffer.from(svg), { density: 192 }).png().toBuffer();
}
