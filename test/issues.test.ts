import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/index.ts';
import { allocateIssue, bindIssueToPost, issueLedger, voidIssue } from '../src/issues.ts';

function tempStore(): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sf-issue-'));
  const store = Store.open(join(dir, 't.db'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('期号按 (label, column) 独立序列从 1 起单调分配，跨栏目互不串号', () => {
  const { store, close } = tempStore();
  try {
    assert.equal(allocateIssue(store, 1, 'column.anomaly'), 1);
    assert.equal(allocateIssue(store, 1, 'column.anomaly'), 2);
    assert.equal(allocateIssue(store, 1, 'column.anomaly'), 3);
    assert.equal(allocateIssue(store, 1, 'column.recap'), 1, '另一栏从 1 起，序列按 column_id 独立');
    assert.equal(allocateIssue(store, 2, 'column.anomaly'), 1, '另一标签从 1 起，序列按 label_id 独立');
  } finally {
    close();
  }
});

test('void 号不回收、不重发，且连续率机检把 void 记为"已让号"而非断号', () => {
  const { store, close } = tempStore();
  try {
    const a = allocateIssue(store, 1, 'column.recap');      // 1
    const b = allocateIssue(store, 1, 'column.recap');      // 2
    allocateIssue(store, 1, 'column.recap');                // 3
    voidIssue(store, 1, 'column.recap', b);                 // 2 作废
    const next = allocateIssue(store, 1, 'column.recap');   // 4，绝不复用 2
    assert.equal(b, 2);
    assert.equal(next, 4, '作废的号不回收，下一个必须是 4');
    const ledger = issueLedger(store, 1, 'column.recap');
    assert.equal(ledger.max, 4);
    assert.equal(ledger.voided, 1);
    assert.equal(ledger.issued, 3);
    assert.deepEqual(ledger.missing, [], '2 是 void（已让号），不是断号；只要 1..max 都有记录连续率就 100%');
    assert.equal(a, 1);
  } finally {
    close();
  }
});

test('真正的断号（更高的号已分配、中间却缺记录）会被台账抓出来', () => {
  const { store, close } = tempStore();
  try {
    allocateIssue(store, 1, 'column.anomaly'); // 1
    allocateIssue(store, 1, 'column.anomaly'); // 2
    allocateIssue(store, 1, 'column.anomaly'); // 3
    // 手动抹掉 2 —— 读者会看到 NO.1、NO.3 而 NO.2 从没出现过：这才是造假级断号。
    store.db.prepare("DELETE FROM column_issues WHERE label_id = 1 AND column_id = 'column.anomaly' AND issue_no = 2").run();
    const ledger = issueLedger(store, 1, 'column.anomaly');
    assert.equal(ledger.max, 3);
    assert.deepEqual(ledger.missing, [2], '缺号必须被点名，识别带一致率机检据此判 receipt_mismatch');
  } finally {
    close();
  }
});

test('分配拒绝非正整数 label 与空 column_id；对已 void 的号作废/改绑必须抛（不可复活）', () => {
  const { store, close } = tempStore();
  try {
    assert.throws(() => allocateIssue(store, 0, 'column.anomaly'), /label_id 正整数/);
    assert.throws(() => allocateIssue(store, 1.5, 'column.anomaly'), /label_id 正整数/);
    assert.throws(() => allocateIssue(store, 1, ''), /非空 column_id/);

    const n = allocateIssue(store, 1, 'column.anomaly');
    voidIssue(store, 1, 'column.anomaly', n);
    assert.throws(() => voidIssue(store, 1, 'column.anomaly', n), /不是 issued 态/, '已经让出去的号不能再 void 一次假装什么都没发生');
    assert.throws(() => bindIssueToPost(store, 1, 'column.anomaly', n, 999), /不是 issued 态/, 'void 号不许改绑到新帖');
  } finally {
    close();
  }
});

test('bindIssueToPost 把入队时未定的 post_id 回写进 issued 号', () => {
  const { store, close } = tempStore();
  try {
    const n = allocateIssue(store, 1, 'column.recap'); // postId null 入队
    bindIssueToPost(store, 1, 'column.recap', n, 42);
    const row = store.db.prepare('SELECT post_id, state FROM column_issues WHERE issue_no = ?').get(n) as { post_id: number; state: string };
    assert.equal(row.post_id, 42);
    assert.equal(row.state, 'issued');
  } finally {
    close();
  }
});
