import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

/**
 * boot 版本读数（PM seq=400-二）。
 *
 * 现网验收只能靠「某张表在不在」反推线上跑的是哪一代代码——多批次合入后这条路会变不可判定
 * （`column_issues` 在不在，既可能是"没重启"，也可能是"重启了但那个提交没在里面"）。所以每个
 * 进程在启动时把 **自己的** commit 钉一次，之后每轮 tick 原样带出。
 *
 * 语义钉死两条，避免把它读成「当前仓库版本」：
 *   · 它在进程启动时求值一次并永久 memo——之后 `git rev-parse HEAD` 再怎么动，活着的进程里
 *     跑的还是启动那一刻的代码，读数必须跟着代码走，不然反推就是错的；
 *   · 因此读数与 `git rev-parse HEAD` **不一致是有效信息**（= 现网落后于仓库），不是噪声。
 *     判据是「读数存在且是合法 commit 形态」，一致性由人比对两个时刻来解释。
 *
 * 读不出就是 'unknown'，绝不默认成空串或 'main'——「未读当零」是 P0-3 修过的同族错误。
 */

export const UNKNOWN_COMMIT = 'unknown';

export interface BuildInfo {
  commit: string;
  /** 进程启动时刻（ms）：数据分析 §7.8 的 `running_commit` 判据要的是它，不是提交时刻。 */
  booted_at: number;
}

let memo: BuildInfo | null = null;

function readCommit(): string {
  // 面板/守护都从仓库根启动，但稳妥起见把「本文件的上一级」也当候选（src/ → 仓库根）。
  const candidates = [process.cwd(), fileURLToPath(new URL('../..', import.meta.url))];
  for (const cwd of candidates) {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 2_000 });
    const out = (r.stdout ?? '').trim();
    if (r.status === 0 && /^[0-9a-f]{7,40}$/.test(out)) return out;
  }
  return UNKNOWN_COMMIT;
}

/** 每进程一次：git 只在首调时跑，之后是纯内存读。 */
export function buildInfo(): BuildInfo {
  // performance.timeOrigin === process.timeOrigin（进程启动的 epoch ms）；取前者只因项目当前
  // 的 @types/node 没把 timeOrigin 挂到 Process 上，而运行时两者同源。
  if (!memo) memo = { commit: readCommit(), booted_at: Math.round(performance.timeOrigin) };
  return memo;
}

/**
 * tick 的接线点：把本进程的版本读数写进这一轮的 detail（`store.log('tick', res)` 的载荷），
 * 并把它作为 `runningBuild` 设置落一次（同 commit + 同 boot 时刻不重复写）。
 * 只写读数，不改任何行为——观察件共用「不碰额度/间隔/租约」那条边界。
 */
export function stampRunningBuild(store: { getSetting<T>(k: string, f: T): T; setSetting(k: string, v: unknown): void }): BuildInfo {
  const info = buildInfo();
  const prev = store.getSetting<BuildInfo | null>('runningBuild', null);
  if (!prev || prev.commit !== info.commit || prev.booted_at !== info.booted_at) store.setSetting('runningBuild', info);
  return info;
}
