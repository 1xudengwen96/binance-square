import { renderTemplate } from '../engine/render.ts';
import { auditAgainstFacts } from '../engine/verify.ts';
import type { Context, Fact, TemplateDef } from '../engine/types.ts';
import type { Track } from './tracks.ts';
import { findRefusals } from './tracks.ts';

/**
 * An article is not a long post. It is a fixed argument shape, and the shape is the thing
 * readers come back for.
 *
 * The source guide's rule for this lane is "一篇只解决一个问题" — one problem per piece —
 * which in practice means every article has to earn its conclusion. The five sections below
 * are that argument: name the mechanism, show the number, break the naive reading of it,
 * list the misreadings, then hand the reader the means to check all of it themselves.
 *
 * Each section is rendered through the same engine as the short-post templates, so it gets
 * the `requires` contract and the fact ledger for free. That matters more here than it does
 * for posts: an article carries twenty numbers where a post carries three, and a single
 * invented figure in a teaching piece destroys the exact credibility the track is built on.
 */

export interface Section {
  id: string;
  /** Shown in the UI so a draft can be reviewed by structure, not only by prose. */
  label: string;
  body: string;
  requires?: TemplateDef['requires'];
  /**
   * Without this section the piece makes an argument it cannot support, so the whole
   * article is skipped rather than published shorter. The mechanism section is the
   * clearest case: a number with no explanation of what produces it is a tip, not a lesson.
   */
  mandatory?: boolean;
  /**
   * Literal market-shaped numbers this section is allowed to contain. Empty by default:
   * a figure that belongs to the market should come from a field, and a figure that is
   * really part of the argument's arithmetic has to be declared where a reviewer can see it.
   */
  literals?: string[];
}

/** A statement that can be proven wrong by later data — the input to self-correction. */
export interface WindowClaim {
  field: string;
  assertion: 'increasing' | 'decreasing' | 'above' | 'below' | 'paying';
  value?: number;
  phrase: string;
}

export interface ArticleSpec {
  conceptId: string;
  titleOf: (ctx: Context) => string;
  sections: Section[];
  /** Claims worth re-checking after publication. See evidence.ts. */
  claimsOf?: (ctx: Context) => WindowClaim[];
  /** How long the piece stays safe to cite. A live-example article rots with the example. */
  validForHours?: number;
  needsChart?: boolean;
}

export interface SectionResult {
  id: string;
  label: string;
  text: string;
  rendered: boolean;
  skipped?: string;
}

export interface ComposedArticle {
  ok: boolean;
  conceptId: string;
  title: string;
  body: string;
  sections: SectionResult[];
  facts: Fact[];
  claims: WindowClaim[];
  /** Why the piece could not be composed — surfaced, never silently shortened. */
  reason?: string;
  refusalHits: string[];
  chars: number;
}

interface ComposeOptions {
  seed: string | number;
  bank: Record<string, string>;
  track: Track;
  /** Character budget enforced here rather than at publish, so a too-long draft is never
   *  silently truncated into a half-explanation. */
  maxChars?: number;
}

function asTemplate(s: Section, conceptId: string): TemplateDef {
  return {
    id: `${conceptId}.${s.id}`,
    name: s.label,
    category: 'studio',
    style: 'news',
    body: s.body,
    requires: s.requires,
  } as unknown as TemplateDef;
}

/**
 * Derived figures the articles are written against.
 *
 * Computed here rather than inline in the prose for the same reason the fact ledger exists:
 * a number the renderer invents is a number no one can audit. These are all arithmetic on
 * fields that already exist, so they are checkable, and they are registered as facts so the
 * audit accepts them in the output.
 */
export function withDerivedFields(ctx: Context): { ctx: Context; derived: Fact[] } {
  const out: Context = { ...ctx };
  const derived: Fact[] = [];
  const funding = Number(ctx.funding);
  const intervalHours = Number(ctx.intervalHours);
  if (Number.isFinite(funding) && Number.isFinite(intervalHours) && intervalHours > 0) {
    const perDay = 24 / intervalHours;
    const dailyPct = Math.abs(funding) * perDay * 100;
    const add = (field: string, surface: string, value: number): void => {
      out[field] = surface;
      // Registered as facts so the audit treats them as backed by the ledger — they are
      // arithmetic on real fields, not figures the renderer invented.
      derived.push({ surface, value, field, kind: 'number' });
    };
    add('perDay', perDay.toFixed(perDay % 1 === 0 ? 0 : 1), perDay);
    add('dailyCost', `${dailyPct.toFixed(2)}%`, dailyPct);
    add('weeklyCost', `${(dailyPct * 7).toFixed(1)}%`, dailyPct * 7);
  }
  return { ctx: out, derived };
}

/**
 * Square stores article text verbatim.
 *
 * Measured on content 375169413966150: `**bold**` came back inside `bodyTextOnly` with the
 * asterisks intact and the generated layout carrying an empty `style:{}` — the editor does
 * not parse Markdown. So emphasis written in this library has to be carried by structure and
 * word choice, not by markup that readers would see as stray punctuation.
 */
function normalizeForSquare(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*\*/g, '')
    // `{{dir}} {{value}}` interpolation leaves a gap before a Chinese word.
    .replace(/([一-龥]) +([一-龥])/g, '$1$2')
    .replace(/ {3,}/g, '  ');
}

/**
 * A literal market number in the prose is the one thing the fact ledger cannot catch.
 *
 * `auditAgainstFacts` compares a rewrite against what the renderer emitted — and the
 * renderer records a template's own literal digits as facts. So a hardcoded "91234" passes
 * the audit by construction. That is fine for policing the LLM layer and useless for
 * policing the author, which is why this module needs its own rule.
 *
 * The shape rule rather than a blanket digit ban: digits that are list markers (1., 2., 3.)
 * or part of a fixed metric name (24 小时) are legitimate prose. A number that is three or
 * more digits long, or that sits directly against a `%` or a currency unit, is a market
 * claim — and a market claim belongs in a field, where it can go stale honestly and be
 * re-measured, not in a sentence.
 */
const MARKET_LITERAL = /(?:\d[\d,]{2,}|(?<![\w.])\d+(?:\.\d+)?(?=\s*[%$])|(?<=\d)\.\d+(?=\s*%(?!\w)))/g;

export function findUnbackedLiterals(body: string, declared: string[] = []): string[] {
  const declaredSet = new Set(declared);
  const hits = new Set<string>();
  for (const m of body.matchAll(MARKET_LITERAL)) {
    const raw = m[0].replace(/[,\s]/g, '');
    if (declaredSet.has(raw) || declaredSet.has(m[0])) continue;
    hits.add(m[0].trim());
  }
  return [...hits];
}

export function composeArticle(spec: ArticleSpec, rawCtx: Context, opts: ComposeOptions): ComposedArticle {
  const { ctx, derived } = withDerivedFields(rawCtx);
  const sections: SectionResult[] = [];
  const facts: Fact[] = [...derived];
  let mandatoryMissing: string | null = null;

  for (const s of spec.sections) {
    // Checked against the section's *source*, not its output: the rendered text is full of
    // legitimate digits because that is what interpolating fields produces. A literal in the
    // source is the thing the fact ledger cannot see.
    const literals = findUnbackedLiterals(s.body, s.literals);
    if (literals.length) {
      mandatoryMissing = `${s.label}（正文写死了本应来自数据字段的数字：${literals.join('、')}）`;
      sections.push({ id: s.id, label: s.label, text: '', rendered: false, skipped: `字面数字 ${literals.join('、')}` });
      continue;
    }
    const r = renderTemplate(asTemplate(s, spec.conceptId), ctx, { seed: `${opts.seed}:${s.id}`, bank: opts.bank });
    if (!r.ok) {
      sections.push({ id: s.id, label: s.label, text: '', rendered: false, skipped: r.reason });
      if (s.mandatory) mandatoryMissing = `${s.label}（${r.reason}）`;
      continue;
    }
    const text = r.text.trim();
    if (!text) {
      sections.push({ id: s.id, label: s.label, text: '', rendered: false, skipped: '渲染为空' });
      if (s.mandatory) mandatoryMissing = `${s.label}（渲染为空）`;
      continue;
    }
    sections.push({ id: s.id, label: s.label, text: normalizeForSquare(text), rendered: true });
    facts.push(...r.facts);
  }

  const title = normalizeForSquare(spec.titleOf(ctx).trim());
  const body = normalizeForSquare(sections.filter(x => x.rendered).map(x => x.text).join('\n\n'));

  if (mandatoryMissing) {
    return { ok: false, conceptId: spec.conceptId, title, body, sections, facts, claims: [], refusalHits: [], chars: body.length, reason: `缺少支撑段落：${mandatoryMissing}` };
  }
  if (!title || body.length < 200) {
    return { ok: false, conceptId: spec.conceptId, title, body, sections, facts, claims: [], refusalHits: [], chars: body.length, reason: `正文过短（${body.length} 字），不构成一篇教学` };
  }

  // The ledger audit runs on the whole article. Per-section audits would pass while the
  // joined text still contradicted itself — the same number described two different ways
  // in two sections is exactly that failure.
  const audit = auditAgainstFacts(body, facts);
  if (!audit.ok) {
    const invented = [...(audit.inventedNumbers ?? []), ...(audit.inventedSymbols ?? [])];
    return { ok: false, conceptId: spec.conceptId, title, body, sections, facts, claims: [], refusalHits: [], chars: body.length, reason: `台账审计未通过，出现无依据的数字/币种：${invented.join(', ')}` };
  }

  const refusalHits = findRefusals(`${title}\n${body}`, opts.track);
  if (refusalHits.length) {
    return { ok: false, conceptId: spec.conceptId, title, body, sections, facts, claims: [], refusalHits, chars: body.length, reason: `越出赛道边界：${refusalHits.join('；')}` };
  }

  const maxChars = opts.maxChars ?? 6000;
  if (body.length > maxChars) {
    return { ok: false, conceptId: spec.conceptId, title, body, sections, facts, claims: [], refusalHits: [], chars: body.length, reason: `正文 ${body.length} 字，超过 ${maxChars} 字预算；不截断，请精简段落` };
  }

  return {
    ok: true,
    conceptId: spec.conceptId,
    title,
    body,
    sections,
    facts,
    claims: spec.claimsOf?.(ctx) ?? [],
    refusalHits: [],
    chars: body.length,
  };
}

/**
 * Has this article's example stopped being true?
 *
 * A teaching piece anchored to live numbers becomes misinformation on a schedule: "持仓还在
 * 增加" is a sentence with an expiry date. Rather than pretend the article ages well, the
 * runner marks it stale so the concept is re-offered with a fresh example.
 */
export function articleExpired(at: number, validForHours: number | undefined, now = Date.now()): boolean {
  if (!validForHours) return false;
  return now - at > validForHours * 3_600_000;
}
