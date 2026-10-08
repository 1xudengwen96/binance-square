import type { Store } from './db/index.ts';

/**
 * Secrets live in the local SQLite file and are never returned in full by the API.
 * The panel only ever sees a masked hint plus a "is it set" flag, so a screenshot or
 * a leaked GET response cannot expose a key.
 */

export type SecretName = 'squareApiKey' | 'squareApiSecret' | 'openaiApiKey' | 'anthropicApiKey' | 'llmApiKey';

export const SECRET_LABELS: Record<SecretName, string> = {
  squareApiKey: '币安广场 OpenAPI Key',
  squareApiSecret: '广场 Key 的 Secret（当前接口不需要）',
  openaiApiKey: 'OpenAI / 兼容接口 Key',
  anthropicApiKey: 'Anthropic Key',
  llmApiKey: '所选 AI 供应商的 Key',
};

const NAMES = Object.keys(SECRET_LABELS) as SecretName[];
export const SECRET_NAMES: SecretName[] = NAMES.filter(n => n !== 'llmApiKey');

const PREFIX = 'secret:';

export function setSecret(store: Store, name: SecretName, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    store.db.prepare('DELETE FROM settings WHERE key = ?').run(PREFIX + name);
    return;
  }
  store.setSetting(PREFIX + name, trimmed);
}

export function getSecret(store: Store, name: SecretName): string {
  // The env file remains a valid way to supply a key; the UI value wins.
  const stored = store.getSetting<string | null>(PREFIX + name, null);
  if (stored) return stored;
  const fromEnv: Partial<Record<SecretName, string | undefined>> = {
    squareApiKey: process.env.SQUARE_API_KEY,
    squareApiSecret: process.env.SQUARE_API_SECRET,
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  };
  return fromEnv[name] ?? '';
}

/** Show enough to confirm *which* key is stored without revealing it. */
export function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 3)}${'•'.repeat(Math.min(18, value.length - 7))}${value.slice(-4)}`;
}

export interface SecretView {
  name: SecretName;
  label: string;
  set: boolean;
  masked: string;
  fromEnv: boolean;
}

/*
 * Account keys are addressed dynamically — there is one per row of the accounts table,
 * so they cannot live in the fixed SecretName union. They share the same storage and the
 * same rule: never handed back in plaintext, only a masked hint.
 */
export function accountSecretName(accountId: number): string {
  return `account:${accountId}:square`;
}

export function setAccountSecret(store: Store, accountId: number, value: string): void {
  const key = PREFIX + accountSecretName(accountId);
  if (!value.trim()) {
    store.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  store.setSetting(key, value.trim());
}

export function getAccountSecret(store: Store, accountId: number): string {
  return store.getSetting<string | null>(PREFIX + accountSecretName(accountId), null) ?? '';
}

export function accountSecretView(store: Store, accountId: number): { set: boolean; masked: string } {
  const value = getAccountSecret(store, accountId);
  return { set: Boolean(value), masked: mask(value) };
}

export function secretViews(store: Store): SecretView[] {
  return NAMES.map(name => {
    const value = getSecret(store, name);
    const envNames: Partial<Record<SecretName, string>> = {
      squareApiKey: 'SQUARE_API_KEY',
      squareApiSecret: 'SQUARE_API_SECRET',
      openaiApiKey: 'OPENAI_API_KEY',
      anthropicApiKey: 'ANTHROPIC_API_KEY',
    };
    const envVar = envNames[name];
    return {
      name,
      label: SECRET_LABELS[name],
      set: Boolean(value),
      masked: mask(value),
      fromEnv: Boolean(envVar && process.env[envVar] && !store.getSetting<string | null>(PREFIX + name, null)),
    };
  });
}
