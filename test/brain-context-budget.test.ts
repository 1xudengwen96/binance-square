import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { setSecret } from '../src/secrets.ts';
import { brainFor, BRAIN_INPUT_CHAR_LIMITS } from '../src/brain/brain.ts';
import { buildSnapshot, snapshotForModel, snapshotText } from '../src/brain/snapshot.ts';
import { parseReview } from '../src/brain/review.ts';
import { reliability } from '../src/brain/reliability.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'sf-brain-input-'));
  const store = Store.open(join(dir, 'test.db'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  setSecret(store, 'anthropicApiKey', 'primary-test-key');
  setSecret(store, 'brainSecondaryApiKey', 'secondary-test-key');
  const settings = { ...DEFAULT_SETTINGS, llmEnabled: true, llmProvider: 'anthropic' as const,
    llmBaseUrl: 'https://primary.example/v1', llmModel: 'deprecated-temperature-test',
    brainSecondaryProvider: 'openai' as const, brainSecondaryBaseUrl: 'https://secondary.example/v1',
    brainSecondaryModel: 'secondary', brainFallbackEnabled: true };
  return { store, settings };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('model snapshots omit unbounded audit rows, preserve summaries and nulls, and leave the full audit untouched', t => {
  const { store, settings } = fixture(t);
  const full = buildSnapshot(store, settings);
  for (const h of full.hypotheses) {
    h.stratified.cells = Array.from({ length: 100 }, (_, i) => ({ stratum: `funding|小盘|hour=${i}`, comparable: i % 2 === 0,
      arms: [{ arm: 'raw', n: 300, median: 140, postIds: Array.from({ length: 300 }, (_, j) => j) }] }));
    h.stratified.detail = Array.from({ length: 100 }, (_, i) => ({ stratum: `layer${i}`, winner: 'raw', arms: [{ arm: 'raw', n: 300, median: 140 }] }));
    h.stratified.strata = 50; h.stratified.agree = 23; h.stratified.gap = null;
  }
  const original = JSON.stringify(full);
  for (const purpose of ['sentinel', 'weekly', 'review'] as const) {
    const model = snapshotForModel(full, purpose);
    const text = snapshotText(full, purpose);
    assert.ok(text.length < BRAIN_INPUT_CHAR_LIMITS[purpose] - 3000, `${purpose}: ${text.length}`);
    assert.ok(!text.includes('"postIds":'));
    assert.equal(model.gates.B.commentsPer1k, full.gates.B.commentsPer1k);
    for (const h of model.hypotheses) {
      assert.equal(h.stratified.strata, 50);
      assert.equal(h.stratified.agree, 23);
      assert.equal(h.stratified.gap, null);
      assert.equal(h.stratified.auditCounts.cells, 100);
      assert.equal(h.stratified.auditCounts.comparable, 50);
      assert.equal(h.stratified.detail.length, purpose === 'sentinel' ? 0 : 6);
    }
    assert.match(model.contextCoverage.note, /不能据此替代完整分层统计/);
  }
  assert.equal(JSON.stringify(full), original);
});

test('deprecated temperature corrects within two attempts and releases the rejected input reservation', async t => {
  const { store, settings } = fixture(t);
  const seen: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    const body = JSON.parse(init.body); seen.push(body);
    if (seen.length === 1) return response({ error: { message: '`temperature` is deprecated for this model.' } }, 400);
    assert.ok(!('temperature' in body));
    return response({ content: [{ type: 'text', text: '继续观察' }], usage: { input_tokens: 12, output_tokens: 4 } });
  });
  const result = await brainFor(store, { ...settings, brainTokenCapPerDay: 7000 })!.ask({ purpose: 'sentinel', system: '检查', context: '市'.repeat(2000), maxTokens: 100 });
  assert.equal(result.ok, true);
  assert.equal(seen.length, 2);
  const attempts = store.db.prepare('SELECT status,input_tokens FROM brain_attempts ORDER BY id').all() as any[];
  assert.deepEqual(attempts, [{ status: 400, input_tokens: null }, { status: 200, input_tokens: 12 }]);
  const budget = reliability(store).budget as any;
  assert.equal(budget.tokens, 16);
  assert.equal(budget.attempts, 2);
  assert.equal(budget.released, 1);
  assert.equal(budget.estimated, 0);
});

test('a rejected primary does not consume the backup budget or claim measured zero usage', async t => {
  const { store, settings } = fixture(t);
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: any) => {
    urls.push(String(url));
    if (String(url).includes('primary')) return response({ error: { message: 'bad key' } }, 401);
    return response({ choices: [{ message: { content: '诊断完成' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } });
  });
  const result = await brainFor(store, { ...settings, brainTokenCapPerDay: 7000 })!.ask({ purpose: 'sentinel', system: '检查', context: '市'.repeat(2000), maxTokens: 100 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.connection, 'secondary');
  assert.equal(urls.length, 2);
  assert.equal((reliability(store).budget as any).tokens, 16);
});

test('uncertain transport failures and unmetered successes still reserve tokens', t => {
  const { store } = fixture(t);
  const add = store.db.prepare(`INSERT INTO brain_attempts (call_key,at,purpose,connection,provider,model,ok,ms,error_kind,status,reserved_tokens)
    VALUES ('test',?,'sentinel','primary','anthropic','test',?,1,?,?,100)`);
  for (const [ok, kind, status] of [[0, 'configuration', 400], [0, 'auth', 401], [0, 'upstream', 503], [0, 'timeout', null], [1, null, 200], [0, 'in_progress', null]] as const) {
    add.run(Date.now(), ok, kind, status);
  }
  const b = reliability(store).budget as any;
  assert.equal(b.tokens, 400);
  assert.equal(b.released, 2);
  assert.equal(b.estimated, 4);
});

test('oversized prepared input is refused before HTTP and recorded as not sent', async t => {
  const { store, settings } = fixture(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('must not call'); });
  const result = await brainFor(store, settings)!.ask({ purpose: 'sentinel', system: '系统', context: 'x'.repeat(25_000) });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  const row = store.db.prepare('SELECT attempt_count,error_kind,in_chars FROM brain_calls').get() as any;
  assert.equal(row.attempt_count, 0);
  assert.equal(row.error_kind, 'input_limit');
  assert.equal(row.in_chars, 25_002);
  assert.equal((reliability(store).windows[0] as any).notSent, 1);
});

test('review supports array-index citations while rejecting absent and prototype paths', t => {
  const { store, settings } = fixture(t);
  const snap = snapshotForModel(buildSnapshot(store, settings), 'review');
  const review = (path: string, value: unknown) => JSON.stringify({ verdict: 'supported', reason: '口径一致', evidence: [{ path, value }] });
  assert.equal(parseReview(review('definitions[0]', snap.definitions[0]), snap).verdict, 'supported');
  for (const path of ['definitions[-1]', 'definitions[999]', '__proto__.polluted', 'definitions[0].constructor', 'definitions["0"]']) {
    assert.throws(() => parseReview(review(path, 'x'), snap));
  }
});

test('the panel distinguishes prepared characters, unsent work and rejected-request reservations', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/server/public/brain.js'), 'utf8');
  const ctx: any = { window: {}, console, esc: (s: unknown) => String(s ?? ''), fmtTs: () => 'now' };
  runInNewContext(src.replace(/\}\)\(\);\s*$/, 'window.__test = { brainCallsCard, brainReliabilityCard };\n})();'), ctx);
  const calls = ctx.window.__test.brainCallsCard({
    calls_ledger: { tally: { currentKind: 'payer_persists', byKind: {}, total: 0, held: 0, faded: 0, flipped: 0, open: 0 }, recent: [] },
    usage7d: [], calls: [{ at: Date.now(), purpose: 'sentinel', model: 'claude', ms: 1, in_chars: 138781, out_chars: 0,
      ok: 0, attempt_count: 0, error_kind: 'budget', error: '本地预算不足' }],
  });
  assert.match(calls, /未发送 · 本地预算拦截/);
  assert.match(calls, /准备输入 \/ 输出（字符）/);
  assert.match(calls, /不是 token 或费用/);
  const retry = ctx.window.__test.brainReliabilityCard({ settings: { brainAttemptCapPerDay: 40, brainTokenCapPerDay: 200000 },
    reliability: { windows: [], jobs: [], budget: { attempts: 1, tokens: 0, released: 1, estimated: 0 },
      attempts: [{ at: Date.now(), purpose: 'sentinel', connection: 'primary', model: 'claude', ok: 0, status: 400,
        error_kind: 'configuration', ms: 1, input_tokens: null, output_tokens: null }] },
  });
  assert.match(retry, /接口拒绝，已释放预留/);
  assert.match(retry, /费用未知/);
});


test('historical snapshots lacking newer audit fields can still be independently reviewed', t => {
  const { store, settings } = fixture(t);
  const old: any = buildSnapshot(store, settings);
  delete old.gates.B.missingCommentPostIds;
  old.columns = [{ kind: 'question', posts: 5, matured: 4, medianViews: null, commentsPer1k: null }];
  for (const h of old.hypotheses) delete h.stratified.cells;
  const summary = snapshotForModel(old, 'review');
  assert.equal(summary.contextCoverage.missingCommentPosts, null);
  assert.equal(summary.columns[0]!.auditCounts.missing24h, null);
  assert.equal(summary.hypotheses[0]!.stratified.auditCounts.cells, null);
  assert.doesNotThrow(() => JSON.parse(snapshotText(old, 'review')));
});
