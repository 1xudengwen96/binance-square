import type { Store } from './db/index.ts';

/**
 * The render gate (定稿 §3-P0-7，运营定义、后端接线)：
 * 「persona 为空则渲染直接 fail」——上一轮的根病是无定位发帖，读者看三条说不出账号是谁；
 * 只要 persona 核心字段空着还继续出稿，labels 表就只是个贴标签名的装饰。
 *
 * 核心字段 = name + tone 非空字符串（标签手册的其余字段——允许动词表/禁用清单——由运营的
 * persona 内容层校验，本闸门只钉死“人设进内容层”的最低可渲染条件）。
 */
export interface LabelGateVerdict {
  ok: boolean;
  reason?: string;
  labelId?: number;
}

export function labelRenderable(store: Store): LabelGateVerdict {
  const lid = store.activePrimaryLabelId();
  if (lid === null) return { ok: false, reason: '没有 active 主标签：渲染拒绝出稿（P0-2 同一条线）' };
  const row = store.db.prepare('SELECT persona_json FROM labels WHERE id = ?').get(lid) as { persona_json: string | null } | undefined;
  let persona: Record<string, unknown> | null = null;
  try {
    persona = row?.persona_json ? (JSON.parse(row.persona_json) as Record<string, unknown>) : null;
  } catch {
    persona = null;
  }
  if (!persona || typeof persona !== 'object') {
    return { ok: false, reason: '标签人设为空：persona_json 缺失，渲染直接 fail（P0-7 闸门）', labelId: lid };
  }
  const bad = (['name', 'tone'] as const).find(k => typeof persona![k] !== 'string' || !(persona![k] as string).trim());
  if (bad) return { ok: false, reason: `标签人设不完整：persona.${bad} 为空，渲染 fail（P0-7 闸门）`, labelId: lid };
  return { ok: true, labelId: lid };
}
