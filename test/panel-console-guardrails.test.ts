/**
 * 面板护栏：判定口径不可点切、手填降级为观察列。
 *
 * 这两条来自定稿 v1 §7.3。它们不是审美要求，是复发通道：面板上原本有两个按钮组
 * （app.js 的「按浏览量/按互动质量/按返佣优化」与 brain.js 的「实验判定指标」）可以即时
 * 改全局 targetMetric。关卡 A 未过期间互动全零，切过去就会把「样本全是零」判成
 * 「测过了，差别不大」并写进长期记忆 —— 43 帖、合计 1 赞、0 评论的那批假 flat 就是这么来的。
 * 控件留在界面上，任何一次手滑都会重演。所以这里用源码断言把入口焊死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '../src/server/public');
const appJs = readFileSync(join(DIR, 'app.js'), 'utf8');
const brainJs = readFileSync(join(DIR, 'brain.js'), 'utf8');
const PANEL = [{ name: 'app.js', src: appJs }, { name: 'brain.js', src: brainJs }];

test('no panel code may write the judgment metric', () => {
  for (const { name, src } of PANEL) {
    assert.ok(!/\/api\/conversion\/target/.test(src), `${name} still posts to /api/conversion/target`);
    assert.ok(!/\bsetTarget\b|\bbrainTarget\b/.test(src), `${name} still defines or calls a metric-switch handler`);
  }
});

test('the metric is announced as read-only on both pages that show it', () => {
  assert.match(appJs, /function|const\s+targetReadout/);
  assert.match(appJs, /当前世代绑定口径/);
  assert.match(appJs, /改口径＝开新假设/);
  assert.match(brainJs, /实验判定指标[\s\S]{0,600}只读/);
});

test('hand-entered conversion lives in a collapsed observation block labelled approximate', () => {
  const block = appJs.match(/<details class="obs">[\s\S]*?<\/details>/);
  assert.ok(block, 'the manual-entry form is not inside <details class="obs">');
  const html = block[0];
  assert.match(html, /手输近似/);
  assert.match(html, /id="cv-rebate"/, 'the rebate input escaped the collapsed block');
  assert.match(html, /R5 的验收不看这一列/);
  // And the form must not be reachable from the main KPI strip any more.
  assert.ok(!/<h3>今天从币安后台抄三个数/.test(appJs), 'the hand-fill nudge is still a page heading');
  assert.ok(!/按返佣优化|按互动质量优化|按浏览量优化/.test(appJs), 'a metric-switch button is still rendered');
});

/**
 * The class of bug this file is about: deleting a handler and leaving its
 * `window.x = x;` export or an inline onclick behind, which throws on render.
 */
test('every onclick target in the panel actually exists', () => {
  const defined = new Set<string>();
  const names = (src: string, re: RegExp, at: 1 | 2): string[] =>
    [...src.matchAll(re)].map(m => m[at]).filter((s): s is string => Boolean(s));
  for (const { src } of PANEL) {
    for (const n of names(src, /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, 1)) defined.add(n);
    for (const n of names(src, /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, 1)) defined.add(n);
    for (const n of names(src, /^window\.([A-Za-z_$][\w$]*)\s*=/gm, 1)) defined.add(n);
  }
  const builtins = new Set(['confirm', 'alert', 'location']);
  const missing: string[] = [];
  for (const { name, src } of PANEL) {
    for (const fn of names(src, /onclick="([A-Za-z_$][\w$]*)\(/g, 1)) {
      if (!defined.has(fn) && !builtins.has(fn)) missing.push(`${name}: ${fn}`);
    }
    for (const m of src.matchAll(/^window\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*);$/gm)) {
      const exported = m[1] ?? '';
      const target = m[2] ?? '';
      if (defined.has(target)) continue;
      missing.push(`${name}: window.${exported} = ${target} (export of an identifier that no longer exists)`);
    }
  }
  assert.deepEqual(missing, [], `dangling panel handlers: ${missing.join(', ')}`);
});
