export type FieldValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FieldValue[]
  | { [key: string]: FieldValue };

export type Context = Record<string, FieldValue>;

export interface FilterCall {
  name: string;
  arg?: string;
}

export type Node =
  | { kind: 'text'; value: string }
  | { kind: 'interp'; expr: string; filters: FilterCall[] }
  | { kind: 'pool'; options: Node[][] }
  | { kind: 'cond'; branches: { test: string | null; body: Node[] }[] }
  | { kind: 'maybe'; pct: number; body: Node[] }
  | { kind: 'each'; source: string; alias: string; sep: string; max: number; body: Node[] }
  | { kind: 'bank'; path: string; filters: FilterCall[] }
  | { kind: 'require'; fields: string[] };

/** A piece of ground truth that was rendered into the output. */
export interface Fact {
  /** Exactly as it appears in the rendered text. */
  surface: string;
  /** Numeric value when the surface represents one. */
  value: number | null;
  /** Context field it came from, e.g. "chg24h". */
  field: string;
  kind: 'number' | 'symbol' | 'text';
}

/** A field a template declares it needs, with the contract for it. */
export interface FieldSpec {
  /** Dotted path into the material context. */
  path: string;
  /** When false the template is skipped if this path is missing/empty. */
  required?: boolean;
  /** Human-readable reason, surfaced in the trace when a template is skipped. */
  note?: string;
}

export interface TemplateDef {
  id: string;
  name: string;
  /** Material category this template is written for. */
  category: string;
  /** Sub-type within the category, e.g. "funding_extreme". */
  subType?: string;
  /** Writing angle, e.g. "持仓成本". */
  angle?: string;
  /** Style this template belongs to; "any" works across styles. */
  style: string;
  /** Template source. */
  body: string;
  /** Declared data contract. */
  requires?: FieldSpec[];
  /** Relative selection weight; feedback adjusts it. */
  weight?: number;
  enabled?: boolean;
  notes?: string;
}

export interface RenderTrace {
  templateId: string;
  seed: number;
  /** Chosen options from pools, in order. */
  pools: string[];
  /** Word-bank keys resolved. */
  banks: string[];
  /** Branch tests that were taken, as `expr => true`. */
  branches: string[];
  skipped?: string;
}

export interface RenderResult {
  ok: boolean;
  text: string;
  facts: Fact[];
  trace: RenderTrace;
  /** Populated when the template is not eligible for this material. */
  reason?: string;
}
