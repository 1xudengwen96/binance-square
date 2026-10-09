import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { DEFAULT_SETTINGS } from '../src/config.ts';
import { generate } from '../src/pipeline.ts';
import { HYPOTHESES } from '../src/rank/hypotheses.ts';
import { exploreRepeat, REPEAT_EXPLORE_SHARE } from '../src/rank/experiments.ts';
import { makeMaterial } from '../src/material/types.ts';

/** Exactly the fact set `collectors/detectors.ts` puts on a funding material, plus the enriched fields. */
function fundingMaterial(store: Store, symbol: string, at: number): void {
  store.insertMaterial(makeMaterial({
    category: 'funding', subType: 'funding_extreme', title: `${symbol} 资金费率极端`, symbol,
    source: 'test', at, sentiment: 'bear', score: 80,
    facts: {
      cashtag: `$${symbol}`, funding: -0.0125, annualized: -70.2, payer: '空头', intervalHours: 8, price: 1.234,
      longRatio: 0.83, shortRatio: 1.2, chg24h: -3.42, chg1h: -0.41, volMultiple: 2.1, oiChangePct: -8.8,
    },
  }));
}

const SYMBOLS = ['BWET', 'ORDI', 'MINA', 'MET', 'NEAR', 'OGN'];

test('a generated draft carries the arms it was written under', async () => {
  // The parts are tested elsewhere; this is the seam — if `generate` forgot to record the plan,
  // every comparison downstream silently becomes folklore about posts nobody labelled.
  const dir = mkdtempSync(join(tmpdir(), 'sf-arms-'));
  const store = Store.open(join(dir, 't.db'));
  try {
    const s = { ...DEFAULT_SETTINGS, autoPublish: true, dailyCap: 30, postsPerDay: 20 };
    for (const [i, sym] of SYMBOLS.entries()) fundingMaterial(store, sym, Date.now() - i * 1000);
    const r = await generate(store, s, 4);
    assert.ok(r.created.length > 0, `expected drafts, skipped: ${r.skipped.join(' | ')}`);

    const rows = store.db.prepare('SELECT post_id, experiment, arm FROM post_arms').all() as { post_id: number; experiment: string; arm: string }[];
    assert.ok(rows.length >= r.created.length * 3, 'every experiment the draft could vary must be on record');
    for (const e of ['h_chart', 'h_hashtag_count', 'h_opening']) {
      assert.ok(rows.some(x => x.experiment === e), `${e} missing`);
    }
    // The tag line has to match the arm that was drawn, or the experiment measures nothing.
    for (const created of r.created) {
      const arms = Object.fromEntries(
        store.db.prepare('SELECT experiment, arm FROM post_arms WHERE post_id = ?').all(created.id).map((x: any) => [x.experiment, x.arm]),
      );
      const tags = (created.text.match(/#[^\s#]+/g) ?? []).length;
      const want = arms.h_hashtag_count === 'one' ? 1 : arms.h_hashtag_count === 'two' ? 2 : 3;
      assert.equal(tags, want, `arm ${arms.h_hashtag_count} asked for ${want} tags, text has ${tags}: ${created.text}`);
      const hasChart = store.db.prepare('SELECT images_json FROM posts WHERE id = ?').get(created.id) as { images_json: string };
      assert.equal(hasChart.images_json !== '[]', arms.h_chart === 'chart', 'the chart arm must decide whether the post carries a chart');
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every recorded arm is one of the arms the hypothesis declares', async () => {
  // A typo in an arm name does not throw — it quietly creates a second group with one member,
  // and the comparison becomes unreadable. The seed also carries the publish minute, so drafts
  // of the same material at different times differ on purpose; what must never vary is that the
  // label written down is a label the scorer knows.
  const dir = mkdtempSync(join(tmpdir(), 'sf-arms2-'));
  const store = Store.open(join(dir, 't.db'));
  try {
    for (const [i, sym] of SYMBOLS.entries()) fundingMaterial(store, sym, Date.now() - i * 1000);
    const r = await generate(store, { ...DEFAULT_SETTINGS, autoPublish: true }, 4);
    assert.ok(r.created.length > 0);
    const rows = store.db.prepare('SELECT experiment, arm FROM post_arms').all() as { experiment: string; arm: string }[];
    assert.ok(rows.length > 0);
    for (const row of rows) {
      const h = HYPOTHESES.find(x => x.id === row.experiment);
      assert.ok(h, `unknown experiment ${row.experiment} was recorded`);
      assert.ok(h.arms.includes(row.arm), `${row.experiment} has no arm "${row.arm}"`);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the repeat-interval probe is deterministic and spends the share it declares', () => {
  // `h_repeat_interval` asks whether re-posting a coin quickly suppresses itself, and the coin
  // cooldown is the knob that answer should set. With no deliberate bypass the short-interval arm
  // can never receive a row, so the cooldown was being defended by a measurement that could not
  // exist. The bypass has to be reproducible, or a post that skipped the cooldown looks like a bug
  // rather than a decision anyone can audit.
  const seed = 'm:BTC:1:1700000000000';
  assert.equal(exploreRepeat(seed), exploreRepeat(seed), 'same seed must give the same answer');

  const N = 20_000;
  let hits = 0;
  for (let i = 0; i < N; i++) if (exploreRepeat(`seed:${i}`)) hits++;
  const rate = hits / N;
  assert.ok(hits > 0, 'the short-interval arm must be reachable at all');
  assert.ok(Math.abs(rate - REPEAT_EXPLORE_SHARE) < 0.01, `expected about ${(REPEAT_EXPLORE_SHARE * 100).toFixed(0)}%, got ${(rate * 100).toFixed(2)}%`);
});
