import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import type { Settings } from '../src/config.ts';
import { generateColumn } from '../src/column.ts';
import { chat, LlmError } from '../src/llm/providers.ts';

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-recap-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedPersona(store: Store): void {
  store.setLabelPersona(1, { name: '反常观察', tone: '冷静的核账人' });
}

function acct(store: Store, patch: { label?: string; postsPerDay?: number } = {}) {
  const id = store.createAccount({ label: patch.label ?? 'zhang', enabled: true, postsPerDay: patch.postsPerDay });
  return store.accountById(id)!;
}

/** Two judged, unrecapped calls ⇒ owed>=RECAP_MIN_CALLS(2) ⇒ 昨日对账 可抽。 */
function seedOwedCalls(store: Store, now: number): void {
  const ins = store.db.prepare(
    `INSERT INTO column_calls (post_id, symbol, kind, reading, payer, rate_at, annualized_at, interval_hours, price_at, check_at, status, outcome, rate_after, annualized_after, price_after, judged_at, recapped_in)
     VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?,NULL,NULL,?,NULL)`,
  );
  ins.run(1, 'AAA', 'funding_persists', 'ledger', '空头', -0.002, -2, 8, 1, now, 'held', 'held', -0.0019, now);
  ins.run(2, 'BBB', 'funding_persists', 'ledger', '多头', 0.003, 3, 8, 2, now, 'held', 'flipped', -0.0001, now);
}

function funnelRows(store: Store): { outcome: string; drop?: string; kind?: string; slot_at?: number; post_id?: number }[] {
  return (store.db.prepare("SELECT detail FROM events WHERE kind='column_funnel' ORDER BY id").all() as { detail: string }[])
    .map(r => JSON.parse(r.detail));
}

// 钉死时钟：recap 抽签与发帖槽都按 slot.at 派生 seed（QA-FLAKY-001 同款，抽签是夹具不是彩票）。
const FIXED = Date.UTC(2026, 9, 14, 2, 0, 0); // 北京 10-14 10:00

test('昨日对账终于出稿：recap 的 $币种 补登 facts 后过审计，并落 drawn(slot_at)→generated(post_id) 两点', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED });
  const { store, close } = tempStore();
  try {
    seedPersona(store);
    const a = acct(store);
    seedOwedCalls(store, FIXED - 2 * 3600_000);
    // 无 funding 素材 ⇒ pairs 空 ⇒ available=['recap'] ⇒ 必抽 recap；关掉实验臂 ⇒ 不走 AI。
    const s: Settings = { ...DEFAULT_SETTINGS, autoPublish: true, columnPostsPerDay: 10, activeExperiments: [], activeStartHour: 0, activeEndHour: 24 };
    const r = await generateColumn(store, s, a);
    assert.equal(r.created.length, 1, `recap 应出稿一条：${r.skipped.join(' | ')}`);
    const row = store.postById(r.created[0]!.id)!;
    assert.equal(row.template_id, 'column.recap', '3+1 里的「昨日对账」必须真的进可发布集合');
    assert.match(row.text, /\$AAA/);

    const f = funnelRows(store);
    const drawn = f.find(x => x.outcome === 'drawn' && x.kind === 'recap');
    assert.ok(drawn, '抽中 recap 要落 drawn');
    assert.ok(drawn!.slot_at && drawn!.slot_at > 0, 'drawn 必须带 slot_at（裁定二：同小时不再被记 4 次抽中）');
    const gen = f.find(x => x.outcome === 'generated');
    assert.ok(gen && gen.post_id === r.created[0]!.id, '出稿也要落 generated(post_id)，把 drawn→出稿串成一条');
  } finally {
    close();
  }
});

test('被丢弃的抽中不记臂：no_legal_slot 落码且 post_arms 零增长（P2 判定数据靠这条保干净）', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED });
  const { store, close } = tempStore();
  try {
    seedPersona(store);
    const a = acct(store, { postsPerDay: 1 });
    seedOwedCalls(store, FIXED - 2 * 3600_000);
    // 已有 2 条今日短帖 ⇒ nextSlotFor 判 dailyCap 不放行 ⇒ drawn 之前/之后无臂落账。
    for (let i = 0; i < 2; i++) {
      const pid = store.addPost({ materialId: null, templateId: 'x', text: `占位 ${i} $AAA。不构成投资建议。`, status: 'published', scheduledAt: FIXED - i * 1000, accountId: a.id });
      store.db.prepare('UPDATE posts SET published_at = ? WHERE id = ?').run(FIXED - i * 1000, pid);
    }
    const armsBefore = (store.db.prepare('SELECT COUNT(*) n FROM post_arms').get() as { n: number }).n;
    const s: Settings = { ...DEFAULT_SETTINGS, autoPublish: true, columnPostsPerDay: 10, activeExperiments: [], activeStartHour: 0, activeEndHour: 24 };
    const r = await generateColumn(store, s, a);
    assert.equal(r.created.length, 0);
    const f = funnelRows(store);
    assert.ok(f.some(x => x.outcome === 'dropped' && x.drop === 'no_legal_slot'), `日额度挡下要落 no_legal_slot：${JSON.stringify(f)}`);
    const armsAfter = (store.db.prepare('SELECT COUNT(*) n FROM post_arms').get() as { n: number }).n;
    assert.equal(armsAfter, armsBefore, '丢弃轮次绝不许预记臂——否则先记臂再丢弃会污染实验样本');
  } finally {
    close();
  }
});

test('FI-5：columnCoinCooldownHours 缺键兜底 DEFAULT、非数值显式抛错（绕过 settingsFrom 也不静默）', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: FIXED });
  const { store, close } = tempStore();
  try {
    seedPersona(store);
    const a = acct(store);
    const base: Settings = { ...DEFAULT_SETTINGS, autoPublish: true, columnPostsPerDay: 10, activeExperiments: [], activeStartHour: 0, activeEndHour: 24 };
    // 缺键 ⇒ 读到 DEFAULT_SETTINGS(24)，不抛（当前 DEFAULT 无此情形，模拟绕过合并的调用面）。
    const missing = { ...base } as Settings;
    delete (missing as unknown as Record<string, unknown>).columnCoinCooldownHours;
    await generateColumn(store, missing, a); // 不抛即通过（本轮可能因无素材 skip，但绝不因缺键崩）
    // 非数值 ⇒ 必抛，不静默。
    const bad = { ...base, columnCoinCooldownHours: Number.NaN } as Settings;
    await assert.rejects(() => generateColumn(store, bad, a), /非数值/, 'NaN 必须显式报错——静默兜底就是下一次漂移的温床');
  } finally {
    close();
  }
});

/* ------------------------------------------------- AI 闭环：temperature 400 自愈 --- */

interface Req { body: Record<string, unknown> }

test('中转拒非默认 temperature：chat() 去字段重试一次并成功；同模型后续调用不再白付失败往返', async () => {
  const model = 'probe-sonnet-nontemp';
  const reqs: Req[] = [];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      reqs.push({ body: parsed });
      if ('temperature' in parsed) {
        return {
          ok: false, status: 400,
          text: async () => JSON.stringify({ error: { message: `${model} does not support non-default temperature` } }),
        } as unknown as Response;
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ content: [{ type: 'text', text: '改写后的正文' }] }),
      } as unknown as Response;
    }) as typeof fetch;

    const cfg = { provider: 'anthropic' as const, baseUrl: 'https://relay.test/v1', model, apiKey: 'k', temperature: 0.7 };
    const out1 = await chat(cfg, [{ role: 'user', content: 'x' }]);
    assert.equal(out1, '改写后的正文');
    assert.equal(reqs.length, 2, '第一次带 temperature 撞 400，第二次去字段重试');
    assert.ok('temperature' in reqs[0]!.body, '首次仍按调用方意愿发送温度（真实 anthropic 支持）');
    assert.ok(!('temperature' in reqs[1]!.body), '重试必须完全省略该字段，而不是换个数值');

    reqs.length = 0;
    const out2 = await chat(cfg, [{ role: 'user', content: 'y' }]);
    assert.equal(out2, '改写后的正文');
    assert.equal(reqs.length, 1, '该模型已被记档，后续一次成功，不再白付失败往返');
    assert.ok(!('temperature' in reqs[0]!.body));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('非「temperature」类 400 不触发重试，原样抛出（判据只认这一条签名）', async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  try {
    globalThis.fetch = (async (_u: unknown, _i: unknown) => {
      n++;
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'invalid api key' } }) } as unknown as Response;
    }) as typeof fetch;
    const cfg = { provider: 'anthropic' as const, baseUrl: 'https://relay.test/v1', model: 'other-model', apiKey: 'k', temperature: 0.7 };
    await assert.rejects(() => chat(cfg, [{ role: 'user', content: 'x' }]), (e: unknown) => e instanceof LlmError);
    assert.equal(n, 1, '别的 400 只打一次，不做无谓重试');
  } finally {
    globalThis.fetch = realFetch;
  }
});
