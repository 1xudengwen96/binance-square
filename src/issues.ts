/**
 * 期号分配器（定稿 v1.6 §1.4；UI `shared/UI版式规格v1.md` §8.1-2 点名的接线第一步）。
 *
 * 识别带上的 `NO.xxx` 必须来自一个**结构上不可复用**的序列：读者拿期号回看历史，
 * 如果两帖同号，「持续运行」的证据就造假了；如果失败后重发同号，回指会指错内容。
 * 所以规则全部写死在这里，调用方没有自由裁量空间：
 *
 *   1. 入队时分配，不是发布成功时——UI 的 `assertIdentitySafe` 要在图离开渲染层之前
 *      就有号可印，发布时刻已经没有这个信息了。
 *   2. 每 (label_id, column_id) 一条独立序列，从 1 起、单调、int（`issueTag` 拒 0/负/小数）。
 *   3. 发布失败/回滚 → `voidIssue`：不回收、不重发。连续率 100% 的定义 = 已发布序列无缺号，
 *      void 计入分母但记为「已让号」，不算断号。
 *
 * 本模块只提供分配与台账，**不含渲染接线**：接线（column 草稿入队时调用 + 识别带出图）
 * 与 chart_style 世代切换绑在同一个 00:00–08:00 重启窗里落（裁定六 §四-5），在那之前
 * 这里是被单测钉住的惰性数据层，不改变任何现网发布行为。
 */
import type { Store } from './db/index.ts';

export interface IssuedIssue {
  issue_no: number;
  state: 'issued' | 'void';
}

/** 分配下一个期号并登记。返回分配的号；同一 (label, column) 并发重复分配会撞 PK——那是 bug，让它抛。 */
export function allocateIssue(store: Store, labelId: number, columnId: string, postId: number | null = null, now = Date.now()): number {
  if (!Number.isInteger(labelId) || labelId <= 0) throw new Error(`期号分配要求 label_id 正整数，收到 ${String(labelId)}`);
  if (!columnId) throw new Error('期号分配要求非空 column_id');
  const top = store.db
    .prepare('SELECT MAX(issue_no) AS n FROM column_issues WHERE label_id = ? AND column_id = ?')
    .get(labelId, columnId) as { n: number | null };
  const next = (top.n ?? 0) + 1;
  store.db
    .prepare('INSERT INTO column_issues (label_id, column_id, issue_no, state, post_id, created_at) VALUES (?,?,?,?,?,?)')
    .run(labelId, columnId, next, 'issued', postId, now);
  return next;
}

/** 把已分配的号绑到最终帖子（入队时 postId 未知或后置写入的场景）。 */
export function bindIssueToPost(store: Store, labelId: number, columnId: string, issueNo: number, postId: number): void {
  const r = store.db
    .prepare("UPDATE column_issues SET post_id = ? WHERE label_id = ? AND column_id = ? AND issue_no = ? AND state = 'issued'")
    .run(postId, labelId, columnId, issueNo);
  if (r.changes === 0) throw new Error(`期号 ${columnId} NO.${issueNo}（label ${labelId}）不是 issued 态，不许改绑帖子`);
}

/** 发布失败/回滚：标记 void。不删除、不回收——号永远让出去了。 */
export function voidIssue(store: Store, labelId: number, columnId: string, issueNo: number): void {
  const r = store.db
    .prepare("UPDATE column_issues SET state = 'void' WHERE label_id = ? AND column_id = ? AND issue_no = ? AND state = 'issued'")
    .run(labelId, columnId, issueNo);
  if (r.changes === 0) throw new Error(`期号 ${columnId} NO.${issueNo}（label ${labelId}）不是 issued 态，无法作废`);
}

export interface IssueLedger {
  max: number;
  issued: number;
  voided: number;
  /** 已发布序列里的缺号：分配区间内根本不存在记录才算断号；void 不是断号，是让号。 */
  missing: number[];
}

/** 台账读数：连续率机检用。missing 只统计"从未分配过"的洞——那才是造假。 */
export function issueLedger(store: Store, labelId: number, columnId: string): IssueLedger {
  const rows = store.db
    .prepare('SELECT issue_no, state FROM column_issues WHERE label_id = ? AND column_id = ? ORDER BY issue_no')
    .all(labelId, columnId) as IssuedIssue[];
  const byNo = new Set(rows.map(r => r.issue_no));
  const max = rows.length ? Math.max(...byNo) : 0;
  const missing: number[] = [];
  for (let n = 1; n <= max; n++) if (!byNo.has(n)) missing.push(n);
  return {
    max,
    issued: rows.filter(r => r.state === 'issued').length,
    voided: rows.filter(r => r.state === 'void').length,
    missing,
  };
}
