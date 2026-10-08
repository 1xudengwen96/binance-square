/**
 * A style is a lens, not a tone of voice.
 *
 * Seven styles that differ only in synonyms produce seven identical posts — they did, until
 * this file existed. What actually separates them is *which fact about the event each one
 * answers*, so each style declares the fields it must surface. `guard.test.ts` fails the
 * build when a template claims a style but never touches that style's lens.
 *
 * The corollary matters as much as the rule: a material that carries none of a lens's
 * fields cannot be written in that style at all. A headline with no price, no change and no
 * volume is not waiting for a cleverer 数据派 template — it is missing data, and the fix
 * belongs in the collector.
 */
export interface Lens {
  /** The question this style answers about an event. Shown in the UI so the choice is informed. */
  asks: string;
  /** Field names that can answer it. A style-specific template must reference at least one. */
  fields: readonly string[];
  /** Cap on how many numbers the copy may carry. The joke style is light on purpose. */
  maxNumbers?: number;
}

/*
 * Field sets below are built from the real fact keys the collectors emit, not from what
 * the categories sound like they should carry. A field may serve several lenses — the rule
 * is only that a template must touch at least one belonging to the style it claims.
 */
export const LENSES: Record<string, Lens> = {
  tech: {
    asks: '结构走到哪一步了',
    fields: ['price', 'extreme', 'chg24h', 'chg1h', 'tf', 'sustainedMinutes', 'sustainedHours', 'samples', 'dir', 'scoreStart', 'scorePeak', 'rank', 'squareRank',
           // Moving-average structure, once the detector could produce it.
           'maFast', 'maSlow', 'fastLen', 'slowLen', 'gapPct', 'cross'],
  },
  capital: {
    asks: '钱在往哪走、谁在付钱',
    fields: ['funding', 'fundingPct', 'annualized', 'payer', 'oiUsd', 'openInterest', 'oiChangePct', 'volume24h', 'quoteVolume24h', 'volMultiple', 'reserveUsd', 'longRatio', 'chain', 'poolName', 'amountUsd',
           // `shape` names who opened the position — new longs, new shorts, or squeezed stops.
           'shape', 'window', 'venueSharePct', 'venue'],
  },
  data: {
    asks: '这次的量级跟平时差多少',
    fields: ['chg', 'chg24h', 'chg1h', 'topChg', 'board', 'ratio', 'prevRatio', 'ratioDiff', 'volMultiple', 'squareViews', 'squarePosts', 'squareDiscuss', 'attentionScore', 'rank', 'value', 'total', 'delta', 'coinCount',
           'flowUsd', 'flowDir', 'streak', 'squareRank', 'gapRatio'],
  },
  news: {
    asks: '发生了什么、谁说的',
    fields: ['title', 'body', 'wire', 'source_name', 'catalogLabel', 'coins', 'url', 'link', 'ageMinutes'],
  },
  emotion: {
    asks: '人群挤在哪一边',
    fields: ['longPct', 'shortPct', 'ratio', 'agreeing', 'payer', 'dir', 'longRatio', 'squareDiscuss'],
  },
  chat: {
    asks: '我看到之后打算怎么动',
    fields: ['chg', 'chg24h', 'chg1h', 'price', 'ratio', 'funding', 'volMultiple', 'topChg', 'cashtag', 'symbol'],
  },
  joke: {
    asks: '这事儿好笑在哪',
    fields: ['chg', 'chg24h', 'price', 'ratio', 'funding', 'cashtag', 'symbol', 'topChg', 'tf'],
    // Measured on rendered output: a joke that stops for a decimal point is not a joke.
    maxNumbers: 3,
  },
};

/**
 * Extract the fact paths a template body reads, from `{{field}}`, `{{#if field …}}` and
 * `{{#each field …}}`. The `#keyword` prefix is consumed explicitly — a greedy character
 * class here silently ate all but the last letter of every field name and made the guard
 * report nonsense.
 */
export function referencedFields(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(/\{\{(?:#[a-z]+\s+)?([a-zA-Z_][a-zA-Z0-9_.]*)/g)) {
    out.add(m[1]!.split('.')[0]!);
  }
  return out;
}

/** How many numeric literals the rendered copy carries, used by the joke cap. */
export function countNumbers(text: string): number {
  return (text.match(/-?\d[\d,.]*\s*[%倍]?/g) ?? []).length;
}
