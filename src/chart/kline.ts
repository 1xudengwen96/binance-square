import sharp from 'sharp';
import type { Kline } from '../collectors/binance.ts';
import { formatPrice } from '../engine/filters.ts';

/**
 * Server-side candlestick chart, drawn in the Binance terminal look.
 *
 * Square's write API accepts image URLs only, so the chart has to be rasterised
 * here and uploaded through the presigned flow. The font chain matters: Latin
 * and digits land on Consolas (monospaced, terminal feel) while CJK falls
 * through to Microsoft YaHei — pango does per-character fallback.
 */

const UP = '#0ecb81';
const DOWN = '#f6465d';
const BG = '#0b0e11';
const CHART_BG = '#141a20';
const GRID = '#232b33';
const TEXT = '#eaecef';
const DIM = '#707a8a';
const BRIGHT = '#9aa4b2';
const MA_FAST = '#f0b90b';
const MA_SLOW = '#4d8ef7';
const VOL_MA = '#8a93a6';
const FONT = 'Consolas, Microsoft YaHei, Noto Sans CJK SC, DejaVu Sans, sans-serif';

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
  /** What span `changePct` covers, e.g. «近72小时». It is printed next to the number so the header
   *  can never be read as the 24h figure in the footer chips. */
  changeLabel?: string;
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

/** Rough rendered width: CJK glyphs are about twice as wide as Latin ones at the same size. */
function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? size : size * 0.58;
  return w;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

/** UTC+8, matching how the posting schedule is expressed. */
function local(ms: number): Date {
  return new Date(ms + 8 * 3600_000);
}
function dayKey(ms: number): string {
  const d = local(ms);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}
function hhmm(ms: number): string {
  const d = local(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function stamp(ms: number): string {
  return `${dayKey(ms)} ${hhmm(ms)}`;
}

/** Signed numbers pick up the up/down colour so chips read at a glance. */
function colored(s: string): string {
  const re = /[-+]?\d[\d,]*(?:\.\d+)?%?/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index));
    const col = m[0]!.startsWith('-') ? DOWN : m[0]!.startsWith('+') ? UP : TEXT;
    out += `<tspan fill="${col}">${esc(m[0])}</tspan>`;
    last = m.index + m[0]!.length;
  }
  return out + esc(s.slice(last));
}

/** One labelled value pair of the OHLC strip, e.g. «O  0.002048». */
function quote(label: string, value: number | string, valueCol = TEXT): string {
  return `<tspan fill="${DIM}">${label}&#160;&#160;</tspan><tspan fill="${valueCol}">${typeof value === 'number' ? esc(formatPrice(value)) : esc(value)}</tspan>`;
}

export function renderKlineSvg(klines: Kline[], opts: ChartOptions): string {
  const W = opts.width ?? 1200;
  const H = opts.height ?? 760;
  const PAD_L = 16;
  const PAD_R = 96;
  const PAD_T = 88;
  const FOOTER = 56;
  const TIMEBAND = 30;
  const VOL_H = 64;
  // Bands, top to bottom: price, volume, time labels, stat chips.
  const volBottom = H - FOOTER - TIMEBAND;
  const volTop = volBottom - VOL_H;
  const priceBottom = volTop - 10;
  const plotW = W - PAD_L - PAD_R;

  const rows = klines.slice(-(opts.bars ?? 96)).map(k => ({
    t: k[0],
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[7]),
  }));
  if (rows.length < 3) throw new Error('not enough candles to draw a chart');

  const closes = rows.map(r => r.c);
  const vols = rows.map(r => r.v);
  const maFast = sma(closes, 7);
  const maSlow = sma(closes, 25);
  const maVol = sma(vols, 5);

  let lo = Math.min(...rows.map(r => r.l));
  let hi = Math.max(...rows.map(r => r.h));
  let hiIdx = 0;
  let loIdx = 0;
  rows.forEach((r, i) => {
    if (r.h > rows[hiIdx]!.h) hiIdx = i;
    if (r.l < rows[loIdx]!.l) loIdx = i;
  });
  for (const series of [maFast, maSlow]) {
    for (const v of series) {
      if (v === null) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const pad = (hi - lo) * 0.07 || hi * 0.01;
  lo -= pad;
  hi += pad;

  const n = rows.length;
  const step = plotW / n;
  const bodyW = Math.max(2, Math.min(18, step * 0.66));
  const x = (i: number) => PAD_L + step * (i + 0.5);
  const y = (p: number) => PAD_T + ((hi - p) / (hi - lo)) * (priceBottom - PAD_T);
  const maxVol = Math.max(...vols) || 1;
  const vy = (v: number) => volBottom - (v / maxVol) * (volBottom - volTop);

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);
  parts.push(`<rect x="${PAD_L}" y="${PAD_T}" width="${plotW}" height="${priceBottom - PAD_T}" fill="${CHART_BG}"/>`);
  parts.push(`<rect x="${PAD_L}" y="${volTop}" width="${plotW}" height="${volBottom - volTop}" fill="${CHART_BG}"/>`);

  // horizontal price grid + right axis labels
  for (let g = 0; g <= 5; g++) {
    const p = lo + ((hi - lo) * g) / 5;
    const yy = y(p);
    parts.push(`<line x1="${PAD_L}" y1="${yy.toFixed(1)}" x2="${PAD_L + plotW}" y2="${yy.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`);
    parts.push(`<text x="${PAD_L + plotW + 10}" y="${(yy + 4).toFixed(1)}" fill="${DIM}" font-size="13">${esc(formatPrice(p))}</text>`);
  }

  // time axis: a stronger mark at each UTC+8 day boundary, hourly labels in
  // between. A label only survives if it keeps 80px from the previous one.
  type TLabel = { x: number; text: string; strong: boolean };
  const tlabels: TLabel[] = [];
  for (let i = 1; i < n; i++) {
    if (dayKey(rows[i]!.t) !== dayKey(rows[i - 1]!.t)) tlabels.push({ x: x(i), text: dayKey(rows[i]!.t), strong: true });
  }
  const every = Math.max(1, Math.round(n / 7));
  let lastX = -1e9;
  for (let i = 0; i < n; i += every) {
    const lx = x(i);
    if (tlabels.some(L => L.strong && Math.abs(L.x - lx) < 90)) continue;
    if (lx - lastX < 80) continue;
    tlabels.push({ x: lx, text: hhmm(rows[i]!.t), strong: false });
    lastX = lx;
  }
  tlabels.sort((a, b) => a.x - b.x);
  for (const L of tlabels) {
    if (L.strong) parts.push(`<line x1="${L.x.toFixed(1)}" y1="${PAD_T}" x2="${L.x.toFixed(1)}" y2="${volBottom}" stroke="${GRID}" stroke-width="1"/>`);
    parts.push(`<text x="${L.x.toFixed(1)}" y="${(H - FOOTER - 9).toFixed(1)}" fill="${L.strong ? BRIGHT : DIM}" font-size="${L.strong ? 13 : 12.5}" text-anchor="middle">${esc(L.text)}</text>`);
  }

  // volume, plus a quiet MA5 line so a burst is visible against the average
  for (let i = 0; i < n; i++) {
    const r = rows[i]!;
    const col = r.c >= r.o ? UP : DOWN;
    parts.push(`<rect x="${(x(i) - bodyW / 2).toFixed(1)}" y="${vy(r.v).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(1, volBottom - vy(r.v)).toFixed(1)}" fill="${col}" opacity="0.45"/>`);
  }
  let dVol = '';
  let volOpen = false;
  maVol.forEach((v, i) => {
    if (v === null) {
      volOpen = false;
      return;
    }
    dVol += `${volOpen ? 'L' : 'M'}${x(i).toFixed(1)} ${vy(v).toFixed(1)} `;
    volOpen = true;
  });
  if (dVol) parts.push(`<path d="${dVol.trim()}" fill="none" stroke="${VOL_MA}" stroke-width="1.2" opacity="0.85"/>`);

  // candles
  for (let i = 0; i < n; i++) {
    const r = rows[i]!;
    const up = r.c >= r.o;
    const col = up ? UP : DOWN;
    const cx = x(i);
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${y(r.h).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(r.l).toFixed(1)}" stroke="${col}" stroke-width="1.1"/>`);
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
  if (dFast) parts.push(`<path d="${dFast}" fill="none" stroke="${MA_FAST}" stroke-width="1.6"/>`);
  if (dSlow) parts.push(`<path d="${dSlow}" fill="none" stroke="${MA_SLOW}" stroke-width="1.6"/>`);

  // window high / low tags pinned to their bars
  const tag = (i: number, py: number, above: boolean, text: string): string => {
    const w = textWidth(text, 12) + 14;
    const cx = Math.min(Math.max(x(i) - w / 2, PAD_L + 2), PAD_L + plotW - w - 2);
    const ty = above ? Math.max(py - 26, PAD_T + 2) : Math.min(py + 6, priceBottom - 24);
    return (
      `<rect x="${cx.toFixed(1)}" y="${ty.toFixed(1)}" width="${w.toFixed(1)}" height="20" rx="3" fill="#1b232b" stroke="${GRID}"/>` +
      `<text x="${(cx + 7).toFixed(1)}" y="${(ty + 14).toFixed(1)}" fill="${BRIGHT}" font-size="12">${esc(text)}</text>`
    );
  };
  parts.push(tag(hiIdx, y(rows[hiIdx]!.h), true, `H ${formatPrice(rows[hiIdx]!.h)}`));
  parts.push(tag(loIdx, y(rows[loIdx]!.l), false, `L ${formatPrice(rows[loIdx]!.l)}`));

  // last price marker
  const last = rows[n - 1]!;
  const ly = Math.min(Math.max(y(last.c), PAD_T + 13), priceBottom - 13);
  const lastCol = last.c >= last.o ? UP : DOWN;
  parts.push(`<line x1="${PAD_L}" y1="${ly.toFixed(1)}" x2="${PAD_L + plotW}" y2="${ly.toFixed(1)}" stroke="${lastCol}" stroke-width="1" stroke-dasharray="5 4"/>`);
  parts.push(`<rect x="${PAD_L + plotW + 2}" y="${(ly - 13).toFixed(1)}" width="${PAD_R - 8}" height="26" rx="4" fill="${lastCol}"/>`);
  parts.push(`<text x="${PAD_L + plotW + 10}" y="${(ly + 5).toFixed(1)}" fill="#0b0e11" font-size="15" font-weight="bold">${esc(formatPrice(last.c))}</text>`);

  // watermark,交易所截图同款的存在感但压到读图阈值以下
  parts.push(`<text x="${(W / 2).toFixed(0)}" y="${((PAD_T + priceBottom) / 2 + 30).toFixed(0)}" fill="${TEXT}" opacity="0.042" font-size="110" font-weight="bold" letter-spacing="14" text-anchor="middle">BINANCE</text>`);
  // generation stamp rides the footer row's right end — the time band belongs to axis labels
  parts.push(`<text x="${(PAD_L + plotW).toFixed(0)}" y="${(H - FOOTER + 33).toFixed(1)}" fill="${DIM}" font-size="11.5" text-anchor="end" opacity="0.9">${esc(`UTC+8 ${stamp(rows[n - 1]!.t)} · 币安合约`)}</text>`);

  // header row 1: pair + span change; subtitle rides the right edge
  const chg = opts.changePct;
  const chgCol = chg >= 0 ? UP : DOWN;
  parts.push(`<text x="${PAD_L + 4}" y="36" fill="${TEXT}" font-size="26" font-weight="bold">${esc(opts.title)}</text>`);
  const chgText = `${opts.changeLabel ? `${opts.changeLabel} ` : ''}${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
  parts.push(
    `<text x="${(PAD_L + 4 + textWidth(opts.title, 26) + 18).toFixed(0)}" y="36" fill="${chgCol}" font-size="21" font-weight="bold">${esc(chgText)}</text>`,
  );
  if (opts.subtitle) {
    parts.push(`<text x="${(PAD_L + plotW).toFixed(0)}" y="36" fill="${DIM}" font-size="14" text-anchor="end">${esc(opts.subtitle)}</text>`);
  }

  // header row 2: the terminal strip — OHLC of the last closed candle, MA values, VOL
  const strip: string[] = [
    quote('O', last.o),
    quote('H', last.h),
    quote('L', last.l),
    quote('C', last.c, last.c >= last.o ? UP : DOWN),
    `<tspan fill="${MA_FAST}">MA(7) ${esc(formatPrice(maFast[n - 1] ?? last.c))}</tspan>`,
    `<tspan fill="${MA_SLOW}">MA(25) ${esc(formatPrice(maSlow[n - 1] ?? last.c))}</tspan>`,
    `<tspan fill="${DIM}">VOL&#160;&#160;</tspan><tspan fill="${BRIGHT}">${fmtVol(last.v)}</tspan>`,
  ];
  let sx = PAD_L + 4;
  for (const seg of strip) {
    // rough advance: entities count as one space, tags vanish
    const plain = seg.replace(/&#160;/g, ' ').replace(/<[^>]+>/g, '');
    parts.push(`<text x="${sx.toFixed(1)}" y="65" font-size="13.5">${seg}</text>`);
    sx += textWidth(plain, 13.5) + 26;
  }

  // footer stat chips, width follows their text, numbers pick up the trend colour
  let cx = PAD_L + 4;
  for (const c of (opts.stats?.chips ?? []).slice(0, 5)) {
    const w = Math.min(textWidth(c, 14) + 26, 300);
    parts.push(`<rect x="${cx.toFixed(1)}" y="${H - FOOTER + 10}" width="${w.toFixed(1)}" height="34" rx="6" fill="${CHART_BG}" stroke="${GRID}"/>`);
    parts.push(`<text x="${(cx + 13).toFixed(1)}" y="${H - FOOTER + 33}" fill="${DIM}" font-size="14">${colored(c)}</text>`);
    cx += w + 10;
  }

  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * For SVG input, sharp's raster size is driven by `density`: 192 doubles the
 * SVG's own pixel size, so the chart lands retina-crisp without a resize step.
 */
export async function renderKlinePng(klines: Kline[], opts: ChartOptions): Promise<Buffer> {
  const svg = renderKlineSvg(klines, opts);
  return sharp(Buffer.from(svg), { density: 192 }).png().toBuffer();
}

/* ------------------------------------------------------------- card look --- */

const C_BG = '#f7f8fa';
const C_PANEL = '#f0f2f5';
const C_INK = '#1e2329';
const C_MUTED = '#848e9c';
const C_LINE = '#e6e9ed';
// The card is mostly Chinese, and a Consolas-first stack makes pango advance every CJK glyph
// by the monospace cell — 「行情异动」 came out with a gap between every character. The terminal
// render keeps FONT on purpose (its digits are supposed to sit in monospace columns); the card
// leads with the CJK face and lets digits fall through to Consolas only where no CJK face has them.
const FONT_CARD = 'Microsoft YaHei, Noto Sans CJK SC, Consolas, DejaVu Sans, sans-serif';

/** 中文计数单位：广场读者读「2131万」比读「21.31M」快。 */
function fmtVolCn(v: number): string {
  if (v >= 1e8) return `${(v / 1e8).toFixed(v >= 1e9 ? 0 : 1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(0)}万`;
  return v.toFixed(0);
}

/**
 * Width estimate for the card. The terminal renderer's `textWidth` assumes a monospace cell,
 * which is true under Consolas and wrong under YaHei — it put 「/USDT」 inside the tail of 「GTC」.
 * Proportional faces need their own numbers, and bold needs a little more again.
 */
function cw(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? size * 1.02 : size * 0.6;
  return w * (bold ? 1.06 : 1);
}

export interface CardOptions {
  width?: number;
  height?: number;
  bars?: number;
  /** 左上角栏目名，如「行情异动」。 */
  column: string;
  title: string;
  quote?: string;
  market?: string;
  lastPrice: number;
  changePct: number;
  changeLabel?: string;
  /** The big sentence on the card. It must come from audited facts — the renderer
   *  will print whatever it is given, so the caller is the one held to that rule. */
  annotation: string;
  source: string;
  watermark?: string;
  spanLabel?: string;
  high24h?: number;
  low24h?: number;
  turnover24h?: number;
  at?: number;
}

/**
 * The feed-card look: one glanceable claim instead of a terminal screen.
 *
 * In the Square feed the image is a thumbnail, and a thumbnail of ninety-six candles reads as
 * noise — the price, the move and the one audited sentence are what survive the shrink. The
 * candles stay available in the terminal render for whoever opens the post and wants to check
 * the claim against the bars; this card is the cover, not the evidence.
 */
export function renderCardSvg(klines: Kline[], opts: CardOptions): string {
  const W = opts.width ?? 1200;
  const H = opts.height ?? 700;
  const PAD = 48;
  // The 24h figures are read off the full window before the sparkline crop: a card showing
  // 「近 18 小时走势」 must still quote a real 24h high, low and turnover.
  const dayRows = klines.slice(-24).map(k => ({ h: Number(k[2]), l: Number(k[3]), q: Number(k[7]) }));
  const rows = klines.slice(-(opts.bars ?? 48)).map(k => ({ t: k[0], h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), q: Number(k[7]) }));
  if (rows.length < 3) throw new Error('not enough candles to draw a chart');

  const up = opts.changePct >= 0;
  const trend = up ? UP : DOWN;
  const trendSoft = up ? 'rgba(14,203,129,0.12)' : 'rgba(246,70,93,0.12)';

  const high = opts.high24h ?? Math.max(...dayRows.map(r => r.h));
  const low = opts.low24h ?? Math.min(...dayRows.map(r => r.l));
  const turnover = opts.turnover24h ?? dayRows.reduce((s, r) => s + r.q, 0);

  // right-hand sparkline band
  const sx0 = Math.round(W * 0.5);
  const sx1 = W - PAD;
  const sy0 = 132;
  const sy1 = 408;
  const lo = Math.min(...rows.map(r => r.l));
  const hi = Math.max(...rows.map(r => r.h));
  const span = hi - lo || hi * 0.01 || 1;
  const px = (i: number) => sx0 + ((sx1 - sx0) * i) / (rows.length - 1);
  const py = (p: number) => sy0 + ((hi - p) / span) * (sy1 - sy0);
  let line = '';
  rows.forEach((r, i) => { line += `${i ? 'L' : 'M'}${px(i).toFixed(1)} ${py(r.c).toFixed(1)} `; });
  const area = `${line.trim()} L${sx1} ${sy1} L${sx0} ${sy1} Z`;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT_CARD}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${C_BG}"/>`);

  // top row: column tag + timestamp
  parts.push(`<rect x="${PAD}" y="46" width="5" height="26" rx="2" fill="#f0b90b"/>`);
  parts.push(`<text x="${PAD + 16}" y="67" fill="${C_INK}" font-size="21" font-weight="bold">${esc(opts.column)}</text>`);
  const at = opts.at ?? rows[rows.length - 1]!.t;
  const d = local(at);
  parts.push(`<text x="${W - PAD}" y="66" fill="${C_MUTED}" font-size="16" text-anchor="end">${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${hhmm(at)} (UTC+8)</text>`);

  // left column: pair, price, move badge
  parts.push(`<text x="${PAD}" y="168" fill="${C_INK}" font-size="62" font-weight="bold">${esc(opts.title)}</text>`);
  const pairX = PAD + cw(opts.title, 62, true) + 16;
  parts.push(`<text x="${pairX}" y="166" fill="${C_MUTED}" font-size="26">/${esc(opts.quote ?? 'USDT')}</text>`);
  if (opts.market) {
    const mx = pairX + cw(`/${opts.quote ?? 'USDT'}`, 26) + 16;
    const mw = cw(opts.market, 15) + 24;
    parts.push(`<rect x="${mx}" y="140" width="${mw}" height="30" rx="15" fill="${C_PANEL}"/>`);
    parts.push(`<text x="${mx + 12}" y="161" fill="${C_MUTED}" font-size="15">${esc(opts.market)}</text>`);
  }
  parts.push(`<text x="${PAD - 3}" y="268" fill="${C_INK}" font-size="88" font-weight="bold">${esc(formatPrice(opts.lastPrice))}</text>`);
  const badge = `${up ? '▲' : '▼'} ${Math.abs(opts.changePct).toFixed(2)}%`;
  const bw = cw(badge, 27, true) + 40;
  parts.push(`<rect x="${PAD}" y="296" width="${bw}" height="50" rx="25" fill="${trendSoft}"/>`);
  parts.push(`<text x="${PAD + 20}" y="331" fill="${trend}" font-size="27" font-weight="bold">${esc(badge)}</text>`);
  parts.push(`<text x="${PAD + bw + 18}" y="329" fill="${C_MUTED}" font-size="17">${esc(opts.changeLabel ?? '24 小时')}</text>`);

  // right column: the sparkline
  parts.push(`<text x="${sx0}" y="112" fill="${C_MUTED}" font-size="16">${esc(opts.spanLabel ?? `近 ${rows.length} 小时走势`)}</text>`);
  for (const g of [0.15, 0.5, 0.85]) {
    const yy = sy0 + (sy1 - sy0) * g;
    parts.push(`<line x1="${sx0}" y1="${yy.toFixed(1)}" x2="${sx1}" y2="${yy.toFixed(1)}" stroke="${C_LINE}" stroke-width="1" stroke-dasharray="3 5"/>`);
  }
  parts.push(`<path d="${area}" fill="${trend}" opacity="0.14"/>`);
  parts.push(`<path d="${line.trim()}" fill="none" stroke="${trend}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`);
  parts.push(`<circle cx="${sx1.toFixed(1)}" cy="${py(rows[rows.length - 1]!.c).toFixed(1)}" r="6" fill="${trend}"/>`);

  // the one audited sentence, big
  const ay = 462;
  parts.push(`<rect x="${PAD}" y="${ay}" width="${W - PAD * 2}" height="66" rx="8" fill="${C_PANEL}"/>`);
  parts.push(`<rect x="${PAD}" y="${ay}" width="5" height="66" rx="2" fill="${trend}"/>`);
  let note = opts.annotation;
  const maxNote = W - PAD * 2 - 60;
  while (cw(note, 25, true) > maxNote && note.length > 8) note = `${note.slice(0, -2)}…`;
  parts.push(`<text x="${PAD + 28}" y="${ay + 43}" fill="${C_INK}" font-size="25" font-weight="bold">${esc(note)}</text>`);

  // three footer figures
  const cols: [string, string][] = [
    ['24h 最高', formatPrice(high)],
    ['24h 最低', formatPrice(low)],
    ['24h 成交额', fmtVolCn(turnover)],
  ];
  cols.forEach(([label, value], i) => {
    const cx = PAD + i * Math.round((W - PAD * 2) / 3);
    parts.push(`<text x="${cx}" y="596" fill="${C_MUTED}" font-size="16">${esc(label)}</text>`);
    parts.push(`<text x="${cx}" y="640" fill="${C_INK}" font-size="33" font-weight="bold">${esc(value)}</text>`);
  });

  // provenance row
  parts.push(`<line x1="${PAD}" y1="662" x2="${W - PAD}" y2="662" stroke="${C_LINE}" stroke-width="1"/>`);
  parts.push(`<text x="${PAD}" y="688" fill="${C_MUTED}" font-size="15">数据来源：${esc(opts.source)}</text>`);
  if (opts.watermark) parts.push(`<text x="${W - PAD}" y="688" fill="${C_MUTED}" font-size="15" text-anchor="end" opacity="0.85">${esc(opts.watermark)}</text>`);

  parts.push('</svg>');
  return parts.join('\n');
}

export async function renderCardPng(klines: Kline[], opts: CardOptions): Promise<Buffer> {
  const svg = renderCardSvg(klines, opts);
  return sharp(Buffer.from(svg), { density: 192 }).png().toBuffer();
}
