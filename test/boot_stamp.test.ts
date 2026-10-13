import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { buildInfo, stampRunningBuild, UNKNOWN_COMMIT } from '../src/build.ts';
import { tick } from '../src/daemon.ts';

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-boot-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/* ---------------------------------------------------- PM seq=400-二 的判据 --- */

test('boot 版本读数：commit 形态合法、等于本进程代码所在的 HEAD，且每进程只算一次', () => {
  const info = buildInfo();
  assert.match(info.commit, /^([0-9a-f]{7,40}|unknown)$/, '读不出必须是 unknown，不许空串/默认 main（未读当零同族）');
  if (info.commit !== UNKNOWN_COMMIT) {
    // 测试进程启动后工作树没再动过，所以两者应当一致；不一致就说明 memo 被别处改写了。
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(info.commit, head, '读数必须跟着本进程的代码走');
  }
  assert.equal(info.booted_at, Math.round(performance.timeOrigin), 'booted_at 是进程启动时刻，不是提交时刻（裁定九判据要用它比提交时间）');
  assert.ok(info.booted_at <= Date.now());
  assert.equal(buildInfo(), info, 'memo：git 每进程只跑一次');
});

test('boot 版本读数：runningBuild 落一次，同版本重入不重复写', () => {
  const { store, close } = tempStore();
  try {
    let writes = 0;
    const probe = {
      getSetting: <T,>(k: string, f: T): T => store.getSetting<T>(k, f),
      setSetting: (k: string, v: unknown) => {
        writes++;
        store.setSetting(k, v);
      },
    };
    const info = stampRunningBuild(probe);
    assert.equal(writes, 1, '首落写一次');
    assert.deepEqual(store.getSetting('runningBuild', null), info);
    stampRunningBuild(probe);
    assert.equal(writes, 1, '同 commit + 同启动时刻不重复写');
  } finally {
    close();
  }
});

test('boot 版本读数：连「已暂停直接 return」的那一轮 tick 也带得出版本', async () => {
  const { store, close } = tempStore();
  try {
    store.setSetting('paused', { at: Date.now(), reason: '测试' });
    const res = await tick(store, {});
    assert.ok(res.skipped, '这一轮确实走了早退路径');
    assert.equal(res.running_commit, buildInfo().commit, '早退轮也必须能反推线上代码');
    assert.equal(res.running_booted_at, buildInfo().booted_at);
    // tick 的 detail 就是 res 本身（daemon 末尾 store.log('tick', res)），res 带出即 detail 带出。
    // 早退路径不写 tick 事件（P0-3 的既有行为，本次不动），所以版本读数同时落 runningBuild
    // 设置——面板/巡检在不跑完整 tick 时也读得到线上版本。
    assert.deepEqual(store.getSetting('runningBuild', null), { commit: res.running_commit, booted_at: res.running_booted_at });
  } finally {
    close();
  }
});
