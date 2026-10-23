import type { Store } from '../db/index.ts';
import type { Settings } from '../config.ts';
import { getSecret, mask, secretViews } from '../secrets.ts';
import { endpointFor, type LlmConfig } from '../llm/providers.ts';

export type BrainConnection = 'primary' | 'secondary';

export function connectionConfig(store: Store, settings: Settings, slot: BrainConnection): LlmConfig {
  if (slot === 'secondary') return {
    provider: settings.brainSecondaryProvider, baseUrl: settings.brainSecondaryBaseUrl,
    model: settings.brainSecondaryModel, apiKey: getSecret(store, 'brainSecondaryApiKey'),
  };
  return {
    provider: settings.llmProvider, baseUrl: settings.llmBaseUrl,
    model: settings.brainModel.trim() || settings.llmModel,
    apiKey: getSecret(store, settings.llmProvider === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey'),
  };
}

export function connectionView(store: Store, settings: Settings, slot: BrainConnection) {
  const cfg = connectionConfig(store, settings, slot);
  let error: string | null = null;
  let endpoint: string | null = null;
  try { endpoint = endpointFor(cfg); } catch (err) { error = err instanceof Error ? err.message : '地址无效'; }
  if (!error && !cfg.apiKey) error = '还没有保存 Key';
  if (!error && !cfg.model.trim()) error = '还没有选择模型';
  const name = slot === 'secondary' ? 'brainSecondaryApiKey' : cfg.provider === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey';
  const secret = secretViews(store).find(s => s.name === name);
  return {
    slot, provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, endpoint,
    key: { set: Boolean(cfg.apiKey), masked: mask(cfg.apiKey), fromEnv: secret?.fromEnv ?? false },
    ready: !error, error,
  };
}
