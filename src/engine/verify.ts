import type { Fact } from './types.ts';

const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?/g;
const CASHTAG_RE = /\$[A-Za-z][A-Za-z0-9]{0,11}/g;

export interface AuditReport {
  ok: boolean;
  /** Numbers in `text` that no template field produced — i.e. invented. */
  inventedNumbers: string[];
  /** `$TICKER`s that no template field produced. */
  inventedSymbols: string[];
}

function toValue(surface: string): number {
  return Number(surface.replace(/,/g, ''));
}

/**
 * Verify that a piece of text (usually LLM-rewritten) contains no facts the
 * renderer did not emit. This is what makes the polish layer safe to run
 * unattended: a model may reword, but it may not introduce a new number or ticker.
 */
export function auditAgainstFacts(text: string, facts: Fact[]): AuditReport {
  const allowedValues = new Set<number>();
  const allowedSurfaces = new Set<string>();
  const allowedSymbols = new Set<string>();

  for (const f of facts) {
    allowedSurfaces.add(f.surface);
    allowedSurfaces.add(f.surface.replace(/,/g, ''));
    if (f.value !== null && Number.isFinite(f.value)) allowedValues.add(round6(f.value));
    if (f.kind === 'symbol') allowedSymbols.add(f.surface.toUpperCase());
  }

  const inventedNumbers: string[] = [];
  for (const raw of text.match(NUMBER_RE) ?? []) {
    const v = toValue(raw);
    if (Number.isNaN(v)) continue;
    if (allowedSurfaces.has(raw) || allowedValues.has(round6(v))) continue;
    inventedNumbers.push(raw);
  }

  const inventedSymbols: string[] = [];
  for (const raw of text.match(CASHTAG_RE) ?? []) {
    if (allowedSymbols.has(raw.toUpperCase())) continue;
    if ([...allowedSurfaces].some(s => s.toUpperCase().includes(raw.toUpperCase()))) continue;
    inventedSymbols.push(raw);
  }

  return {
    ok: inventedNumbers.length === 0 && inventedSymbols.length === 0,
    inventedNumbers: [...new Set(inventedNumbers)],
    inventedSymbols: [...new Set(inventedSymbols)],
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
